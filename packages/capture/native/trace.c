/*
 * Veyrum's child-process tracer, loaded into processes a test starts through LD_PRELOAD.
 *
 * It appends one line per file-system, exec and network event to the file named by VEYRUM_TRACE:
 *
 *   r <path>  opened for reading          R <path>  open for reading failed: absent
 *   s <path>  status checked (exists)     S <path>  status checked: absent
 *   d <path>  directory listed            w <path>  created, written, renamed or removed
 *   x <path>  executed (traceable)        u <what>  executed something that cannot be traced
 *   n <host> <port>  connected to a network address, or to unix:<path> 0 for a Unix socket
 *
 * Relative paths are made absolute with the working directory, or the directory of the dirfd for
 * the *at functions. Everything else is left to the reader, which normalizes paths.
 *
 * Soundness notes. Only calls that go through the dynamic symbol table are seen: glibc's internal
 * calls (for example the files setlocale or NSS read) are not, which is why those live outside
 * the repository and are covered by the runtime key. Statically linked programs and Go programs
 * make system calls directly: they are executed through veyrum-exec (exec.c), which traces them
 * with ptrace into the same log. Anything else that cannot be followed is reported as untraceable
 * ("u"), which ends reuse. Every exec restores LD_PRELOAD and VEYRUM_TRACE when they are missing,
 * so a program that clears its environment cannot drop the tracer for its children.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <dlfcn.h>
#include <elf.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <spawn.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <unistd.h>

extern char **environ;

#define EXPORT __attribute__((visibility("default")))

static int log_fd = -1;
/* glibc's syscall(): this library interposes it, so its own system calls go through this pointer. */
static long (*sys)(long, ...);
static char preload_value[PATH_MAX * 4];
static char trace_value[PATH_MAX];
/* Set while recording, so libc calls made by the recording itself are not recorded. */
static __thread int busy __attribute__((tls_model("initial-exec")));

/* ---- logging ------------------------------------------------------------------------------ */

/*
 * The next definition of a symbol. glibc before 2.33 exported the stat family as __xstat and
 * friends, which newer glibc keeps only as versioned compatibility symbols.
 */
static void *lookup(const char *name) {
  void *p = dlsym(RTLD_NEXT, name);
  static const char *const versions[] = {"GLIBC_2.2.5", "GLIBC_2.17", "GLIBC_2.0"};
  for (size_t i = 0; !p && i < sizeof versions / sizeof *versions; i++) p = dlvsym(RTLD_NEXT, name, versions[i]);
  if (!p) {
    /* Only reachable when a program calls a function its C library lacks. */
    static const char message[] = "veyrum-trace: missing C library function\n";
    if (sys) sys(SYS_write, 2, message, sizeof message - 1);
    _exit(127);
  }
  return p;
}

/* The log's identity: programs can reuse its descriptor number (dup2), so it is checked per write. */
static dev_t log_dev;
static ino_t log_ino;

/* Descriptors from here up are unlikely to be chosen by the program for its own purposes. */
#define LOG_FD_FLOOR 900

static int log_open(void) {
  int fd = (int)sys(SYS_openat, AT_FDCWD, trace_value, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0600);
  if (fd < 0) return -1;
  int high = (int)sys(SYS_fcntl, fd, F_DUPFD_CLOEXEC, LOG_FD_FLOOR);
  if (high >= 0) {
    sys(SYS_close, fd);
    fd = high;
  }
  struct stat st;
  if (sys(SYS_fstat, fd, &st) != 0) {
    sys(SYS_close, fd);
    return -1;
  }
  log_dev = st.st_dev;
  log_ino = st.st_ino;
  return fd;
}

static void log_init(void) {
  sys = (long (*)(long, ...))lookup("syscall");
  const char *trace = getenv("VEYRUM_TRACE");
  const char *preload = getenv("LD_PRELOAD");
  if (!trace || !*trace || strlen(trace) >= sizeof trace_value) return;
  if (!preload || strlen(preload) >= sizeof preload_value) return;
  strcpy(trace_value, trace);
  strcpy(preload_value, preload);
  log_fd = log_open();
}

/*
 * Appends to the log, first making sure the descriptor still is the log: a forked child about to
 * exec, or a shell handling a redirection, may have put another file (an IPC channel) at its number.
 */
static void log_write(const char *buf, size_t len) {
  struct stat st;
  if (sys(SYS_fstat, log_fd, &st) != 0 || st.st_dev != log_dev || st.st_ino != log_ino) {
    int fd = log_open();
    if (fd < 0) return;
    log_fd = fd;
  }
  sys(SYS_write, log_fd, buf, len);
}

__attribute__((constructor)) static void veyrum_trace_init(void) { log_init(); }

static size_t append(char *buf, size_t at, size_t cap, const char *s) {
  size_t n = strlen(s);
  if (at + n >= cap) return cap;
  memcpy(buf + at, s, n);
  return at + n;
}

/* Directory a relative path is resolved against: the working directory, or the dirfd's. */
static int base_dir(int dirfd, char *out, size_t cap) {
  if (dirfd == AT_FDCWD) {
    long n = sys(SYS_getcwd, out, cap);
    return n > 0 ? 0 : -1;
  }
  char link[64];
  snprintf(link, sizeof link, "/proc/self/fd/%d", dirfd);
  long n = sys(SYS_readlinkat, AT_FDCWD, link, out, cap - 1);
  if (n <= 0) return -1;
  out[n] = '\0';
  return 0;
}

static void emit_at(char kind, int dirfd, const char *path) {
  if (log_fd < 0 || !path || !*path) return;
  int saved = errno;
  char line[PATH_MAX * 2 + 8];
  size_t at = 0;
  line[at++] = kind;
  line[at++] = ' ';
  if (path[0] != '/') {
    char dir[PATH_MAX];
    if (base_dir(dirfd, dir, sizeof dir) != 0) {
      errno = saved;
      return;
    }
    at = append(line, at, sizeof line, dir);
    at = append(line, at, sizeof line, "/");
  }
  at = append(line, at, sizeof line, path);
  /* A path that does not fit, or that contains a newline, cannot be recorded faithfully. */
  if (at >= sizeof line - 1 || strchr(path, '\n')) {
    static const char overflow[] = "u unrecordable path\n";
    log_write(overflow, sizeof overflow - 1);
    errno = saved;
    return;
  }
  line[at++] = '\n';
  log_write(line, at);
  errno = saved;
}

static void emit(char kind, const char *path) { emit_at(kind, AT_FDCWD, path); }

#define REAL(ret, name, ...)                                   \
  static ret (*real_##name)(__VA_ARGS__);                      \
  if (!real_##name) real_##name = (ret(*)(__VA_ARGS__))(uintptr_t)lookup(#name)

/* ---- opening files -------------------------------------------------------------------------- */

static int wants_write(int flags) { return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) != 0; }

static void opened(int dirfd, const char *path, int flags, int result) {
  if (busy) return;
  busy = 1;
  if (result >= 0 && (flags & O_PATH)) {
    emit_at('s', dirfd, path);
  } else if (result >= 0) {
    /* O_RDWR reads too: record the read before the write. */
    if (!(flags & O_WRONLY)) emit_at((flags & O_DIRECTORY) ? 'd' : 'r', dirfd, path);
    if (wants_write(flags)) emit_at('w', dirfd, path);
  } else if (errno == ENOENT || errno == ENOTDIR) {
    emit_at(wants_write(flags) ? 'w' : 'R', dirfd, path);
  }
  busy = 0;
}

static mode_t mode_arg(int flags, va_list ap) {
  return (flags & (O_CREAT | __O_TMPFILE)) ? (mode_t)va_arg(ap, int) : 0;
}

EXPORT int open(const char *path, int flags, ...) {
  REAL(int, open, const char *, int, ...);
  va_list ap;
  va_start(ap, flags);
  mode_t mode = mode_arg(flags, ap);
  va_end(ap);
  int r = real_open(path, flags, mode);
  opened(AT_FDCWD, path, flags, r);
  return r;
}

EXPORT int open64(const char *path, int flags, ...) {
  REAL(int, open64, const char *, int, ...);
  va_list ap;
  va_start(ap, flags);
  mode_t mode = mode_arg(flags, ap);
  va_end(ap);
  int r = real_open64(path, flags, mode);
  opened(AT_FDCWD, path, flags, r);
  return r;
}

EXPORT int openat(int dirfd, const char *path, int flags, ...) {
  REAL(int, openat, int, const char *, int, ...);
  va_list ap;
  va_start(ap, flags);
  mode_t mode = mode_arg(flags, ap);
  va_end(ap);
  int r = real_openat(dirfd, path, flags, mode);
  opened(dirfd, path, flags, r);
  return r;
}

EXPORT int openat64(int dirfd, const char *path, int flags, ...) {
  REAL(int, openat64, int, const char *, int, ...);
  va_list ap;
  va_start(ap, flags);
  mode_t mode = mode_arg(flags, ap);
  va_end(ap);
  int r = real_openat64(dirfd, path, flags, mode);
  opened(dirfd, path, flags, r);
  return r;
}

EXPORT int __open_2(const char *path, int flags) {
  REAL(int, __open_2, const char *, int);
  int r = real___open_2(path, flags);
  opened(AT_FDCWD, path, flags, r);
  return r;
}

EXPORT int __open64_2(const char *path, int flags) {
  REAL(int, __open64_2, const char *, int);
  int r = real___open64_2(path, flags);
  opened(AT_FDCWD, path, flags, r);
  return r;
}

EXPORT int __openat_2(int dirfd, const char *path, int flags) {
  REAL(int, __openat_2, int, const char *, int);
  int r = real___openat_2(dirfd, path, flags);
  opened(dirfd, path, flags, r);
  return r;
}

EXPORT int __openat64_2(int dirfd, const char *path, int flags) {
  REAL(int, __openat64_2, int, const char *, int);
  int r = real___openat64_2(dirfd, path, flags);
  opened(dirfd, path, flags, r);
  return r;
}

EXPORT int creat(const char *path, mode_t mode) {
  REAL(int, creat, const char *, mode_t);
  int r = real_creat(path, mode);
  if (!busy) emit('w', path);
  return r;
}

EXPORT int creat64(const char *path, mode_t mode) {
  REAL(int, creat64, const char *, mode_t);
  int r = real_creat64(path, mode);
  if (!busy) emit('w', path);
  return r;
}

static int fopen_flags(const char *mode) {
  int flags = strchr(mode, '+') ? O_RDWR : (mode[0] == 'r' ? O_RDONLY : O_WRONLY);
  if (mode[0] == 'w') flags |= O_CREAT | O_TRUNC;
  if (mode[0] == 'a') flags |= O_CREAT | O_APPEND;
  return flags;
}

static void fopened(const char *path, const char *mode, FILE *f) {
  opened(AT_FDCWD, path, fopen_flags(mode), f ? 0 : -1);
}

EXPORT FILE *fopen(const char *path, const char *mode) {
  REAL(FILE *, fopen, const char *, const char *);
  FILE *f = real_fopen(path, mode);
  fopened(path, mode, f);
  return f;
}

EXPORT FILE *fopen64(const char *path, const char *mode) {
  REAL(FILE *, fopen64, const char *, const char *);
  FILE *f = real_fopen64(path, mode);
  fopened(path, mode, f);
  return f;
}

EXPORT FILE *freopen(const char *path, const char *mode, FILE *stream) {
  REAL(FILE *, freopen, const char *, const char *, FILE *);
  FILE *f = real_freopen(path, mode, stream);
  if (path) fopened(path, mode, f);
  return f;
}

EXPORT FILE *freopen64(const char *path, const char *mode, FILE *stream) {
  REAL(FILE *, freopen64, const char *, const char *, FILE *);
  FILE *f = real_freopen64(path, mode, stream);
  if (path) fopened(path, mode, f);
  return f;
}

/* ---- status checks -------------------------------------------------------------------------- */

static void checked(int dirfd, const char *path, int result) {
  if (busy) return;
  busy = 1;
  if (result == 0) emit_at('s', dirfd, path);
  else if (errno == ENOENT || errno == ENOTDIR) emit_at('S', dirfd, path);
  busy = 0;
}

#define STAT_LIKE(name, stat_type)                                    \
  EXPORT int name(const char *path, struct stat_type *buf) {          \
    REAL(int, name, const char *, struct stat_type *);                \
    int r = real_##name(path, buf);                                   \
    checked(AT_FDCWD, path, r);                                       \
    return r;                                                         \
  }

STAT_LIKE(stat, stat)
STAT_LIKE(lstat, stat)
STAT_LIKE(stat64, stat64)
STAT_LIKE(lstat64, stat64)

EXPORT int fstatat(int dirfd, const char *path, struct stat *buf, int flags) {
  REAL(int, fstatat, int, const char *, struct stat *, int);
  int r = real_fstatat(dirfd, path, buf, flags);
  /* An empty path with AT_EMPTY_PATH is fstat on the descriptor: no path is involved. */
  if (!(flags & AT_EMPTY_PATH) || *path) checked(dirfd, path, r);
  return r;
}

EXPORT int fstatat64(int dirfd, const char *path, struct stat64 *buf, int flags) {
  REAL(int, fstatat64, int, const char *, struct stat64 *, int);
  int r = real_fstatat64(dirfd, path, buf, flags);
  if (!(flags & AT_EMPTY_PATH) || *path) checked(dirfd, path, r);
  return r;
}

/* glibc before 2.33 exports the stat family under these names. */
#define XSTAT_LIKE(name, stat_type)                                           \
  EXPORT int name(int ver, const char *path, struct stat_type *buf) {         \
    REAL(int, name, int, const char *, struct stat_type *);                   \
    int r = real_##name(ver, path, buf);                                      \
    checked(AT_FDCWD, path, r);                                               \
    return r;                                                                 \
  }

XSTAT_LIKE(__xstat, stat)
XSTAT_LIKE(__lxstat, stat)
XSTAT_LIKE(__xstat64, stat64)
XSTAT_LIKE(__lxstat64, stat64)

EXPORT int __fxstatat(int ver, int dirfd, const char *path, struct stat *buf, int flags) {
  REAL(int, __fxstatat, int, int, const char *, struct stat *, int);
  int r = real___fxstatat(ver, dirfd, path, buf, flags);
  if (!(flags & AT_EMPTY_PATH) || *path) checked(dirfd, path, r);
  return r;
}

EXPORT int __fxstatat64(int ver, int dirfd, const char *path, struct stat64 *buf, int flags) {
  REAL(int, __fxstatat64, int, int, const char *, struct stat64 *, int);
  int r = real___fxstatat64(ver, dirfd, path, buf, flags);
  if (!(flags & AT_EMPTY_PATH) || *path) checked(dirfd, path, r);
  return r;
}

EXPORT int statx(int dirfd, const char *path, int flags, unsigned int mask, struct statx *buf) {
  REAL(int, statx, int, const char *, int, unsigned int, struct statx *);
  int r = real_statx(dirfd, path, flags, mask, buf);
  if (!(flags & AT_EMPTY_PATH) || *path) checked(dirfd, path, r);
  return r;
}

EXPORT int access(const char *path, int mode) {
  REAL(int, access, const char *, int);
  int r = real_access(path, mode);
  checked(AT_FDCWD, path, r == 0 || errno != ENOENT ? 0 : -1);
  return r;
}

EXPORT int faccessat(int dirfd, const char *path, int mode, int flags) {
  REAL(int, faccessat, int, const char *, int, int);
  int r = real_faccessat(dirfd, path, mode, flags);
  checked(dirfd, path, r == 0 || errno != ENOENT ? 0 : -1);
  return r;
}

EXPORT int euidaccess(const char *path, int mode) {
  REAL(int, euidaccess, const char *, int);
  int r = real_euidaccess(path, mode);
  checked(AT_FDCWD, path, r == 0 || errno != ENOENT ? 0 : -1);
  return r;
}

EXPORT int eaccess(const char *path, int mode) {
  REAL(int, eaccess, const char *, int);
  int r = real_eaccess(path, mode);
  checked(AT_FDCWD, path, r == 0 || errno != ENOENT ? 0 : -1);
  return r;
}

EXPORT ssize_t readlink(const char *path, char *buf, size_t size) {
  REAL(ssize_t, readlink, const char *, char *, size_t);
  ssize_t r = real_readlink(path, buf, size);
  if (!busy) {
    busy = 1;
    emit(r >= 0 ? 'r' : (errno == ENOENT || errno == ENOTDIR ? 'R' : 's'), path);
    busy = 0;
  }
  return r;
}

EXPORT ssize_t readlinkat(int dirfd, const char *path, char *buf, size_t size) {
  REAL(ssize_t, readlinkat, int, const char *, char *, size_t);
  ssize_t r = real_readlinkat(dirfd, path, buf, size);
  if (!busy) {
    busy = 1;
    emit_at(r >= 0 ? 'r' : (errno == ENOENT || errno == ENOTDIR ? 'R' : 's'), dirfd, path);
    busy = 0;
  }
  return r;
}

/* realpath resolves each component internally; its result depends on every symlink on the way. */
EXPORT char *realpath(const char *path, char *resolved) {
  REAL(char *, realpath, const char *, char *);
  char *r = real_realpath(path, resolved);
  if (!busy) {
    busy = 1;
    if (r) {
      emit('s', path);
      emit('s', r);
    } else if (errno == ENOENT || errno == ENOTDIR) {
      emit('S', path);
    } else {
      emit('u', "realpath");
    }
    busy = 0;
  }
  return r;
}

EXPORT char *canonicalize_file_name(const char *path) {
  REAL(char *, canonicalize_file_name, const char *);
  char *r = real_canonicalize_file_name(path);
  if (!busy) {
    busy = 1;
    if (r) {
      emit('s', path);
      emit('s', r);
    } else if (errno == ENOENT || errno == ENOTDIR) {
      emit('S', path);
    } else {
      emit('u', "canonicalize_file_name");
    }
    busy = 0;
  }
  return r;
}

/* ---- directories ---------------------------------------------------------------------------- */

EXPORT DIR *opendir(const char *path) {
  REAL(DIR *, opendir, const char *);
  DIR *d = real_opendir(path);
  if (!busy) {
    busy = 1;
    if (d) emit('d', path);
    else if (errno == ENOENT || errno == ENOTDIR) emit('S', path);
    busy = 0;
  }
  return d;
}

/* Listing a directory opened by descriptor: the descriptor's path, as the kernel reports it. */
EXPORT DIR *fdopendir(int fd) {
  REAL(DIR *, fdopendir, int);
  DIR *d = real_fdopendir(fd);
  if (d && !busy && log_fd >= 0) {
    busy = 1;
    char dir[PATH_MAX];
    if (base_dir(fd, dir, sizeof dir) == 0) emit('d', dir);
    else emit('u', "fdopendir");
    busy = 0;
  }
  return d;
}

typedef int (*dirent_filter)(const struct dirent *);
typedef int (*dirent_compare)(const struct dirent **, const struct dirent **);
typedef int (*dirent64_filter)(const struct dirent64 *);
typedef int (*dirent64_compare)(const struct dirent64 **, const struct dirent64 **);

EXPORT int scandir(const char *path, struct dirent ***list, dirent_filter filter, dirent_compare compare) {
  REAL(int, scandir, const char *, struct dirent ***, dirent_filter, dirent_compare);
  int r = real_scandir(path, list, filter, compare);
  if (!busy) {
    busy = 1;
    if (r >= 0) emit('d', path);
    else if (errno == ENOENT || errno == ENOTDIR) emit('S', path);
    busy = 0;
  }
  return r;
}

EXPORT int scandir64(const char *path, struct dirent64 ***list, dirent64_filter filter,
                     dirent64_compare compare) {
  REAL(int, scandir64, const char *, struct dirent64 ***, dirent64_filter, dirent64_compare);
  int r = real_scandir64(path, list, filter, compare);
  if (!busy) {
    busy = 1;
    if (r >= 0) emit('d', path);
    else if (errno == ENOENT || errno == ENOTDIR) emit('S', path);
    busy = 0;
  }
  return r;
}

/* Recursive walks and pattern expansion read many directories internally. */
#define UNTRACEABLE(ret, name, params, args)                    \
  EXPORT ret name params {                                      \
    static void *real_##name;                                   \
    if (!real_##name) real_##name = lookup(#name);              \
    if (!busy) emit('u', #name);                                \
    return ((ret(*) params)real_##name) args;                   \
  }

struct FTW;
typedef int (*ftw_fn)(const char *, const struct stat *, int);
typedef int (*nftw_fn)(const char *, const struct stat *, int, struct FTW *);
UNTRACEABLE(int, ftw, (const char *dir, ftw_fn fn, int fds), (dir, fn, fds))
UNTRACEABLE(int, nftw, (const char *dir, nftw_fn fn, int fds, int flags), (dir, fn, fds, flags))
UNTRACEABLE(int, glob, (const char *pattern, int flags, int (*errfunc)(const char *, int), void *pglob),
            (pattern, flags, errfunc, pglob))
UNTRACEABLE(int, glob64, (const char *pattern, int flags, int (*errfunc)(const char *, int), void *pglob),
            (pattern, flags, errfunc, pglob))

/* ---- writes --------------------------------------------------------------------------------- */

#define WRITE1(name)                                          \
  EXPORT int name(const char *path) {                         \
    REAL(int, name, const char *);                            \
    int r = real_##name(path);                                \
    if (!busy) emit('w', path);                               \
    return r;                                                 \
  }

WRITE1(unlink)
WRITE1(rmdir)

EXPORT int unlinkat(int dirfd, const char *path, int flags) {
  REAL(int, unlinkat, int, const char *, int);
  int r = real_unlinkat(dirfd, path, flags);
  if (!busy) emit_at('w', dirfd, path);
  return r;
}

EXPORT int mkdir(const char *path, mode_t mode) {
  REAL(int, mkdir, const char *, mode_t);
  int r = real_mkdir(path, mode);
  if (!busy) emit('w', path);
  return r;
}

EXPORT int mkdirat(int dirfd, const char *path, mode_t mode) {
  REAL(int, mkdirat, int, const char *, mode_t);
  int r = real_mkdirat(dirfd, path, mode);
  if (!busy) emit_at('w', dirfd, path);
  return r;
}

EXPORT int rename(const char *from, const char *to) {
  REAL(int, rename, const char *, const char *);
  int r = real_rename(from, to);
  if (!busy) {
    emit('w', from);
    emit('w', to);
  }
  return r;
}

EXPORT int renameat(int fromfd, const char *from, int tofd, const char *to) {
  REAL(int, renameat, int, const char *, int, const char *);
  int r = real_renameat(fromfd, from, tofd, to);
  if (!busy) {
    emit_at('w', fromfd, from);
    emit_at('w', tofd, to);
  }
  return r;
}

EXPORT int renameat2(int fromfd, const char *from, int tofd, const char *to, unsigned int flags) {
  REAL(int, renameat2, int, const char *, int, const char *, unsigned int);
  int r = real_renameat2(fromfd, from, tofd, to, flags);
  if (!busy) {
    emit_at('w', fromfd, from);
    emit_at('w', tofd, to);
  }
  return r;
}

EXPORT int symlink(const char *target, const char *path) {
  REAL(int, symlink, const char *, const char *);
  int r = real_symlink(target, path);
  if (!busy) emit('w', path);
  return r;
}

EXPORT int symlinkat(const char *target, int dirfd, const char *path) {
  REAL(int, symlinkat, const char *, int, const char *);
  int r = real_symlinkat(target, dirfd, path);
  if (!busy) emit_at('w', dirfd, path);
  return r;
}

EXPORT int link(const char *from, const char *to) {
  REAL(int, link, const char *, const char *);
  int r = real_link(from, to);
  if (!busy) {
    emit('r', from);
    emit('w', to);
  }
  return r;
}

EXPORT int linkat(int fromfd, const char *from, int tofd, const char *to, int flags) {
  REAL(int, linkat, int, const char *, int, const char *, int);
  int r = real_linkat(fromfd, from, tofd, to, flags);
  if (!busy) {
    emit_at('r', fromfd, from);
    emit_at('w', tofd, to);
  }
  return r;
}

EXPORT int truncate(const char *path, off_t length) {
  REAL(int, truncate, const char *, off_t);
  int r = real_truncate(path, length);
  if (!busy) emit('w', path);
  return r;
}

EXPORT char *mkdtemp(char *template) {
  REAL(char *, mkdtemp, char *);
  char *r = real_mkdtemp(template);
  if (r && !busy) emit('w', r);
  return r;
}

/* ---- raw system calls ----------------------------------------------------------------------- */

/*
 * Programs can bypass the functions above with syscall(). libuv, and so Node, checks file status
 * this way (statx). The file-system calls among them are recorded like their libc functions; an
 * exec this way cannot re-inject the tracer and is untraceable.
 */
EXPORT long syscall(long number, ...) {
  va_list ap;
  va_start(ap, number);
  long a[6];
  for (int i = 0; i < 6; i++) a[i] = va_arg(ap, long);
  va_end(ap);
  if (!sys) sys = (long (*)(long, ...))lookup("syscall");
  if (log_fd >= 0 && !busy && (number == SYS_execve || number == SYS_execveat)) emit('u', "raw exec");
  long r = sys(number, a[0], a[1], a[2], a[3], a[4], a[5]);
  if (log_fd < 0 || busy) return r;
  switch (number) {
    case SYS_statx:
      if (!((int)a[2] & AT_EMPTY_PATH) || (a[1] && *(const char *)a[1])) checked((int)a[0], (const char *)a[1], (int)r);
      break;
    case SYS_newfstatat:
      if (!((int)a[3] & AT_EMPTY_PATH) || (a[1] && *(const char *)a[1])) checked((int)a[0], (const char *)a[1], (int)r);
      break;
    case SYS_openat:
      opened((int)a[0], (const char *)a[1], (int)a[2], (int)r);
      break;
    case SYS_faccessat:
#ifdef SYS_faccessat2
    case SYS_faccessat2:
#endif
      checked((int)a[0], (const char *)a[1], r == 0 || errno != ENOENT ? 0 : -1);
      break;
    case SYS_readlinkat:
      checked((int)a[0], (const char *)a[1], r >= 0 ? 0 : -1);
      break;
#ifdef SYS_open
    case SYS_open:
      opened(AT_FDCWD, (const char *)a[0], (int)a[1], (int)r);
      break;
    case SYS_stat:
    case SYS_lstat:
      checked(AT_FDCWD, (const char *)a[0], (int)r);
      break;
    case SYS_access:
      checked(AT_FDCWD, (const char *)a[0], r == 0 || errno != ENOENT ? 0 : -1);
      break;
    case SYS_readlink:
      checked(AT_FDCWD, (const char *)a[0], r >= 0 ? 0 : -1);
      break;
#endif
#ifdef SYS_openat2
    case SYS_openat2:
      if (r >= 0) emit('u', "openat2");
      break;
#endif
    default:
      break;
  }
  return r;
}

/* ---- libraries ------------------------------------------------------------------------------ */

EXPORT void *dlopen(const char *path, int flags) {
  REAL(void *, dlopen, const char *, int);
  void *h = real_dlopen(path, flags);
  /* A bare name is found by the loader among system libraries, which the runtime key covers. */
  if (!busy && path && strchr(path, '/')) emit(h ? 'r' : 'R', path);
  return h;
}

/* ---- network -------------------------------------------------------------------------------- */

EXPORT int connect(int fd, const struct sockaddr *addr, socklen_t len) {
  REAL(int, connect, int, const struct sockaddr *, socklen_t);
  int r = real_connect(fd, addr, len);
  if (log_fd >= 0 && !busy && addr && (r == 0 || errno == EINPROGRESS)) {
    char line[PATH_MAX + 128];
    int n = -1;
    if (addr->sa_family == AF_INET) {
      const struct sockaddr_in *in = (const struct sockaddr_in *)addr;
      char host[INET_ADDRSTRLEN];
      inet_ntop(AF_INET, &in->sin_addr, host, sizeof host);
      n = snprintf(line, sizeof line, "n %s %u\n", host, ntohs(in->sin_port));
    } else if (addr->sa_family == AF_INET6) {
      const struct sockaddr_in6 *in6 = (const struct sockaddr_in6 *)addr;
      char host[INET6_ADDRSTRLEN];
      inet_ntop(AF_INET6, &in6->sin6_addr, host, sizeof host);
      n = snprintf(line, sizeof line, "n %s %u\n", host, ntohs(in6->sin6_port));
    } else if (addr->sa_family == AF_UNIX) {
      /* Treated like the test's own Unix socket connections: local. */
      const struct sockaddr_un *un = (const struct sockaddr_un *)addr;
      n = snprintf(line, sizeof line, "n unix:%.*s 0\n", (int)sizeof un->sun_path, un->sun_path[0] ? un->sun_path : "abstract");
    }
    if (n > 0 && (size_t)n < sizeof line) {
      int saved = errno;
      log_write(line, (size_t)n);
      errno = saved;
    }
  }
  return r;
}

/* ---- exec ----------------------------------------------------------------------------------- */

static int pread_all(int fd, void *buf, size_t size, off_t offset) {
  return sys(SYS_pread64, fd, buf, size, offset) == (long)size ? 0 : -1;
}

/* True when the ELF file has a section with the given name (Go binaries carry .go.buildinfo). */
static int has_go_section(int fd, const Elf64_Ehdr *eh) {
  if (eh->e_shoff == 0 || eh->e_shstrndx == SHN_UNDEF || eh->e_shnum == 0 || eh->e_shnum > 4096) return 0;
  Elf64_Shdr strtab;
  if (pread_all(fd, &strtab, sizeof strtab, (off_t)(eh->e_shoff + (Elf64_Off)eh->e_shstrndx * eh->e_shentsize)))
    return 0;
  for (int i = 0; i < eh->e_shnum; i++) {
    Elf64_Shdr sh;
    if (pread_all(fd, &sh, sizeof sh, (off_t)(eh->e_shoff + (Elf64_Off)i * eh->e_shentsize))) return 0;
    char name[32] = {0};
    if (sys(SYS_pread64, fd, name, sizeof name - 1, (off_t)(strtab.sh_offset + sh.sh_name)) <= 0) continue;
    if (strncmp(name, ".go.buildinfo", 13) == 0 || strncmp(name, ".note.go.buildid", 16) == 0) return 1;
  }
  return 0;
}

/* How a program runs under capture. */
enum run { RUN_TRACED, RUN_LAUNCHED, RUN_UNTRACEABLE };

#if defined(__x86_64__)
#define NATIVE_MACHINE EM_X86_64
#elif defined(__aarch64__)
#define NATIVE_MACHINE EM_AARCH64
#else
#define NATIVE_MACHINE EM_NONE
#endif

/*
 * A dynamically linked, non-Go ELF file is traced by this library; a statically linked or Go one
 * for this machine runs under veyrum-exec; a script runs as its interpreter would (followed a few
 * levels). Anything else cannot be followed. Must match classifyExecutable in src/trace.ts.
 */
static enum run classify(const char *path, int depth) {
  if (depth > 4) return RUN_UNTRACEABLE;
  int fd = (int)sys(SYS_openat, AT_FDCWD, path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return RUN_TRACED; /* The exec will fail; nothing runs. */
  unsigned char head[256];
  long n = sys(SYS_read, fd, head, sizeof head - 1);
  enum run kind = RUN_UNTRACEABLE;
  if (n >= 2 && head[0] == '#' && head[1] == '!') {
    head[n] = '\0';
    char *p = (char *)head + 2;
    while (*p == ' ' || *p == '\t') p++;
    char *end = p;
    while (*end && *end != ' ' && *end != '\t' && *end != '\n') end++;
    *end = '\0';
    if (*p) kind = classify(p, depth + 1);
  } else if (n >= (long)sizeof(Elf64_Ehdr) && memcmp(head, ELFMAG, SELFMAG) == 0 && head[EI_CLASS] == ELFCLASS64) {
    Elf64_Ehdr eh;
    memcpy(&eh, head, sizeof eh);
    int dynamic = 0;
    for (int i = 0; i < eh.e_phnum && i < 512; i++) {
      Elf64_Phdr ph;
      if (pread_all(fd, &ph, sizeof ph, (off_t)(eh.e_phoff + (Elf64_Off)i * eh.e_phentsize))) break;
      if (ph.p_type == PT_INTERP) dynamic = 1;
    }
    if (dynamic && !has_go_section(fd, &eh)) kind = RUN_TRACED;
    else if (eh.e_machine == NATIVE_MACHINE) kind = RUN_LAUNCHED;
  }
  sys(SYS_close, fd);
  return kind;
}

/* The file execvp would run: the name itself when it has a slash, else the first match on PATH. */
static int search_path(const char *file, const char *path_env, char *out, size_t cap) {
  if (strchr(file, '/')) {
    if (strlen(file) >= cap) return -1;
    strcpy(out, file);
    return 0;
  }
  const char *dirs = path_env ? path_env : "/bin:/usr/bin";
  while (*dirs) {
    const char *colon = strchr(dirs, ':');
    size_t len = colon ? (size_t)(colon - dirs) : strlen(dirs);
    if (len + strlen(file) + 2 < cap) {
      if (len == 0) {
        strcpy(out, file);
      } else {
        memcpy(out, dirs, len);
        out[len] = '/';
        strcpy(out + len + 1, file);
      }
      if (sys(SYS_faccessat, AT_FDCWD, out, X_OK) == 0) return 0;
    }
    if (!colon) break;
    dirs = colon + 1;
  }
  return -1;
}

static const char *env_lookup(char *const envp[], const char *name) {
  size_t len = strlen(name);
  for (char *const *e = envp; e && *e; e++)
    if (strncmp(*e, name, len) == 0 && (*e)[len] == '=') return *e + len + 1;
  return NULL;
}

static const char *launcher_path(void);

/*
 * Records an exec. Returns whether it must go through veyrum-exec, which then records the program
 * itself (or that it could not trace it).
 */
static int is_launcher(const char *path);

static int record_exec(const char *resolved) {
  if (log_fd < 0 || busy) return 0;
  busy = 1;
  /* The launcher itself (a nested capture's) is Veyrum, not an input, and traces what it runs. */
  if (is_launcher(resolved)) {
    busy = 0;
    return 0;
  }
  enum run kind = classify(resolved, 0);
  int launch = kind == RUN_LAUNCHED && launcher_path() != NULL;
  if (kind == RUN_TRACED) emit('x', resolved);
  else if (!launch) emit('u', resolved);
  busy = 0;
  return launch;
}

/* This library's own file name, from the dynamic loader. */
static const char *own_path(void) {
  static char path[PATH_MAX];
  if (!path[0]) {
    Dl_info info;
    if (dladdr((void *)own_path, &info) && info.dli_fname && strlen(info.dli_fname) < sizeof path)
      strcpy(path, info.dli_fname);
  }
  return path;
}

/* veyrum-exec, built next to this library, or NULL when it was not. */
static const char *launcher_path(void) {
  static char path[PATH_MAX];
  static int state; /* 0 unknown, 1 present, -1 absent */
  if (!state) {
    state = -1;
    const char *own = own_path();
    const char *slash = strrchr(own, '/');
    size_t dir = slash ? (size_t)(slash - own) : 0;
    if (slash && dir + sizeof "/veyrum-exec" <= sizeof path) {
      memcpy(path, own, dir);
      strcpy(path + dir, "/veyrum-exec");
      if (sys(SYS_faccessat, AT_FDCWD, path, X_OK) == 0) state = 1;
    }
  }
  return state > 0 ? path : NULL;
}

static int is_launcher(const char *path) {
  const char *launcher = launcher_path();
  struct stat a, b;
  return launcher && sys(SYS_newfstatat, AT_FDCWD, path, &a, 0) == 0 &&
         sys(SYS_newfstatat, AT_FDCWD, launcher, &b, 0) == 0 && a.st_dev == b.st_dev && a.st_ino == b.st_ino;
}

static size_t argv_count(char *const argv[]) {
  size_t n = 0;
  while (argv && argv[n]) n++;
  return n;
}

/* The arguments that run `program` through veyrum-exec. `out` has room for argv plus three. */
static void launch_argv(const char *program, char *const argv[], char **out) {
  out[0] = (char *)launcher_path();
  out[1] = (char *)program;
  size_t i = 0;
  for (; argv && argv[i]; i++) out[i + 2] = argv[i];
  out[i + 2] = NULL;
}

/* Whether a colon-separated LD_PRELOAD value lists this library. */
static int lists_library(const char *value) {
  const char *own = own_path();
  size_t len = strlen(own);
  if (!len) return 0;
  for (const char *p = value; (p = strstr(p, own)) != NULL; p += len)
    if ((p == value || p[-1] == ':' || p[-1] == ' ') && (p[len] == '\0' || p[len] == ':' || p[len] == ' ')) return 1;
  return 0;
}

/*
 * The environment for an exec: the given one, with the tracer restored if the program removed it.
 * A VEYRUM_TRACE that is present is kept: a traced process that starts a child for its own capture
 * (Veyrum testing itself) points it at another log on purpose. Written into `out`, which has room
 * for the given entries plus three.
 */
static char preload_entry[sizeof preload_value + PATH_MAX + 16];
static char trace_entry[sizeof trace_value + 16];
static void traced_env(char *const envp[], char **out) {
  const char *preload = NULL;
  int has_trace = 0;
  size_t n = 0;
  for (char *const *e = envp; e && *e; e++) {
    if (strncmp(*e, "LD_PRELOAD=", 11) == 0) {
      preload = *e + 11;
      continue;
    }
    if (strncmp(*e, "VEYRUM_TRACE=", 13) == 0 && (*e)[13]) has_trace = 1;
    out[n++] = *e;
  }
  if (preload && lists_library(preload)) {
    snprintf(preload_entry, sizeof preload_entry, "LD_PRELOAD=%s", preload);
  } else if (preload && *preload) {
    snprintf(preload_entry, sizeof preload_entry, "LD_PRELOAD=%s:%s", own_path(), preload);
  } else {
    snprintf(preload_entry, sizeof preload_entry, "LD_PRELOAD=%s", preload_value);
  }
  out[n++] = preload_entry;
  if (!has_trace) {
    snprintf(trace_entry, sizeof trace_entry, "VEYRUM_TRACE=%s", trace_value);
    out[n++] = trace_entry;
  }
  out[n] = NULL;
}

static size_t env_count(char *const envp[]) {
  size_t n = 0;
  for (char *const *e = envp; e && *e; e++) n++;
  return n;
}

EXPORT int execve(const char *path, char *const argv[], char *const envp[]) {
  REAL(int, execve, const char *, char *const[], char *const[]);
  if (log_fd < 0) return real_execve(path, argv, envp);
  int launch = record_exec(path);
  char *env[env_count(envp) + 3];
  traced_env(envp, env);
  if (launch) {
    char *args[argv_count(argv) + 3];
    launch_argv(path, argv, args);
    return real_execve(args[0], args, env);
  }
  return real_execve(path, argv, env);
}

EXPORT int execv(const char *path, char *const argv[]) { return execve(path, argv, environ); }

EXPORT int execvpe(const char *file, char *const argv[], char *const envp[]) {
  REAL(int, execvpe, const char *, char *const[], char *const[]);
  if (log_fd < 0) return real_execvpe(file, argv, envp);
  char resolved[PATH_MAX];
  int launch = search_path(file, env_lookup(envp, "PATH"), resolved, sizeof resolved) == 0 && record_exec(resolved);
  char *env[env_count(envp) + 3];
  traced_env(envp, env);
  if (launch) {
    REAL(int, execve, const char *, char *const[], char *const[]);
    char *args[argv_count(argv) + 3];
    launch_argv(resolved, argv, args);
    return real_execve(args[0], args, env);
  }
  return real_execvpe(file, argv, env);
}

EXPORT int execvp(const char *file, char *const argv[]) { return execvpe(file, argv, environ); }

/* The variadic forms collect their arguments into an array (bounded like the kernel's limit). */
#define MAX_ARGS 4096
#define COLLECT_ARGS(first, ap, argv)                          \
  const char *argv[MAX_ARGS];                                  \
  size_t argc = 0;                                             \
  argv[argc++] = first;                                        \
  while (argc < MAX_ARGS - 1 && (argv[argc] = va_arg(ap, const char *)) != NULL) argc++; \
  argv[argc] = NULL

EXPORT int execl(const char *path, const char *arg, ...) {
  va_list ap;
  va_start(ap, arg);
  COLLECT_ARGS(arg, ap, argv);
  va_end(ap);
  return execve(path, (char *const *)argv, environ);
}

EXPORT int execlp(const char *file, const char *arg, ...) {
  va_list ap;
  va_start(ap, arg);
  COLLECT_ARGS(arg, ap, argv);
  va_end(ap);
  return execvpe(file, (char *const *)argv, environ);
}

EXPORT int execle(const char *path, const char *arg, ...) {
  va_list ap;
  va_start(ap, arg);
  COLLECT_ARGS(arg, ap, argv);
  char *const *envp = va_arg(ap, char *const *);
  va_end(ap);
  return execve(path, (char *const *)argv, envp);
}

EXPORT int fexecve(int fd, char *const argv[], char *const envp[]) {
  REAL(int, fexecve, int, char *const[], char *const[]);
  if (log_fd < 0) return real_fexecve(fd, argv, envp);
  emit('u', "fexecve");
  char *env[env_count(envp) + 3];
  traced_env(envp, env);
  return real_fexecve(fd, argv, env);
}

EXPORT int execveat(int dirfd, const char *path, char *const argv[], char *const envp[], int flags) {
  REAL(int, execveat, int, const char *, char *const[], char *const[], int);
  if (log_fd < 0) return real_execveat(dirfd, path, argv, envp, flags);
  int launch = 0;
  if (path[0] == '/' && !(flags & AT_EMPTY_PATH)) launch = record_exec(path);
  else emit('u', "execveat");
  char *env[env_count(envp) + 3];
  traced_env(envp, env);
  if (launch) {
    REAL(int, execve, const char *, char *const[], char *const[]);
    char *args[argv_count(argv) + 3];
    launch_argv(path, argv, args);
    return real_execve(args[0], args, env);
  }
  return real_execveat(dirfd, path, argv, env, flags);
}

EXPORT int posix_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *actions,
                       const posix_spawnattr_t *attr, char *const argv[], char *const envp[]) {
  REAL(int, posix_spawn, pid_t *, const char *, const posix_spawn_file_actions_t *, const posix_spawnattr_t *,
       char *const[], char *const[]);
  if (log_fd < 0) return real_posix_spawn(pid, path, actions, attr, argv, envp);
  int launch = record_exec(path);
  char *env[env_count(envp) + 3];
  traced_env(envp, env);
  if (launch) {
    char *args[argv_count(argv) + 3];
    launch_argv(path, argv, args);
    return real_posix_spawn(pid, args[0], actions, attr, args, env);
  }
  return real_posix_spawn(pid, path, actions, attr, argv, env);
}

EXPORT int posix_spawnp(pid_t *pid, const char *file, const posix_spawn_file_actions_t *actions,
                        const posix_spawnattr_t *attr, char *const argv[], char *const envp[]) {
  REAL(int, posix_spawnp, pid_t *, const char *, const posix_spawn_file_actions_t *, const posix_spawnattr_t *,
       char *const[], char *const[]);
  if (log_fd < 0) return real_posix_spawnp(pid, file, actions, attr, argv, envp);
  char resolved[PATH_MAX];
  int launch = search_path(file, env_lookup(envp, "PATH"), resolved, sizeof resolved) == 0 && record_exec(resolved);
  char *env[env_count(envp) + 3];
  traced_env(envp, env);
  if (launch) {
    REAL(int, posix_spawn, pid_t *, const char *, const posix_spawn_file_actions_t *, const posix_spawnattr_t *,
         char *const[], char *const[]);
    char *args[argv_count(argv) + 3];
    launch_argv(resolved, argv, args);
    return real_posix_spawn(pid, args[0], actions, attr, args, env);
  }
  return real_posix_spawnp(pid, file, actions, attr, argv, env);
}
