/*
 * Veyrum's child-process tracer on macOS, loaded into the processes a test starts through
 * DYLD_INSERT_LIBRARIES. It interposes libSystem's functions (dyld's __interpose section) and
 * appends the lines trace.c describes (r/R/s/S/d/w/x/u/n) to the file named by VEYRUM_TRACE.
 *
 * Interposing rebinds every image's calls, including libSystem's calls between its own libraries:
 * fopen, opendir, fts and setlocale all end in the open, stat and getdirentries functions here, so
 * the C library's internal file access is seen too. A directory is listed only when its entries
 * are read (__getdirentries64, getattrlistbulk), whatever opened it. Go programs call libSystem on
 * macOS and are traced like any other. Calls made by this library itself are never rebound, so it
 * uses libSystem freely, except for functions that take locks a hooked caller may hold (the
 * printf family takes the locale lock setlocale holds while it opens locale files): lines are
 * built by hand.
 *
 * Programs dyld does not load this library into: protected ones. System Integrity Protection
 * removes DYLD_* variables for Apple's platform binaries (everything in /bin, /usr/bin, /System),
 * and the hardened runtime does for programs signed with it unless they carry the
 * allow-dyld-environment-variables entitlement (and disable-library-validation, or an injected
 * ad hoc library kills them). Such a program runs as a shadow copy: copied into the run's scratch
 * directory once per file version (path, device, inode, modification time, size), signed ad hoc
 * without the runtime flag (codesign --force --sign -, which drops the flags and entitlements),
 * and executed with the arguments it would have had, argv[0] included. A script whose
 * interpreter is protected runs its interpreter's shadow, with the arguments the kernel would
 * pass. On Apple silicon system binaries are arm64e only, and a machine may refuse to run an ad
 * hoc arm64e program (with System Integrity Protection on); whether it does is checked once per
 * run with a shadow of /usr/bin/true. A program that cannot be traced (set-user-ID, a __RESTRICT
 * segment, a protected program that finds its libraries relative to itself or is an application's
 * executable, which a copy would not run as, a shadow copy that could not be made or run) runs
 * untraced, as itself, and the log records it ("u"), which ends reuse. Every exec restores DYLD_INSERT_LIBRARIES and VEYRUM_TRACE
 * when a program removed them.
 *
 * Also recorded: every library loaded from outside the dyld shared cache ("r", the program's own
 * dependencies included) and the absent candidates of a PATH lookup this library performs.
 * Not seen: system calls made without libSystem (raw svc instructions, which macOS does not
 * support as an interface), and file access by the kernel on the program's behalf.
 */
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <mach-o/fat.h>
#include <mach-o/loader.h>
#include <netinet/in.h>
#include <pthread.h>
#include <signal.h>
#include <spawn.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/param.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysctl.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>
#if __has_feature(ptrauth_calls)
#include <ptrauth.h>
#endif

extern char **environ;

#ifndef MH_DYLIB_IN_CACHE
#define MH_DYLIB_IN_CACHE 0x80000000u
#endif
#if defined(__x86_64__)
#define STATX_NP_SYMBOL "_statx_np$INODE64"
#define LSTATX_NP_SYMBOL "_lstatx_np$INODE64"
#else
#define STATX_NP_SYMBOL "_statx_np"
#define LSTATX_NP_SYMBOL "_lstatx_np"
#endif

/* ---- the functions interposed, under names of their own ----------------------------------------- */

/*
 * Declared here with the exact symbol each one binds to: some are not in the SDK's headers. Weak,
 * so the library loads on systems older than the SDK where one is missing (it is then interposed
 * nowhere, as nothing can call it).
 */
#define WEAK __attribute__((weak_import))
WEAK extern int sys_open_nocancel(const char *, int, ...) __asm("_open$NOCANCEL");
WEAK extern int sys_openat_nocancel(int, const char *, int, ...) __asm("_openat$NOCANCEL");
WEAK extern int sys___open_nocancel(const char *, int, int) __asm("___open_nocancel");
WEAK extern int sys___openat_nocancel(int, const char *, int, int) __asm("___openat_nocancel");
WEAK extern int sys_open_dprotected_np(const char *, int, int, int, ...) __asm("_open_dprotected_np");
WEAK extern int sys_openat_dprotected_np(int, const char *, int, int, int, ...) __asm("_openat_dprotected_np");
WEAK extern int sys_guarded_open_np(const char *, const uint64_t *, unsigned int, int, ...) __asm("_guarded_open_np");
WEAK extern int sys_guarded_open_dprotected_np(const char *, const uint64_t *, unsigned int, int, int, int, ...) __asm(
    "_guarded_open_dprotected_np");
WEAK extern int sys_openbyid_np(void *, void *, int) __asm("_openbyid_np");
WEAK extern int sys_openx_np(const char *, int, void *) __asm("_openx_np");
WEAK extern int sys_stat64(const char *, void *) __asm("_stat64");
WEAK extern int sys_lstat64(const char *, void *) __asm("_lstat64");
WEAK extern int sys_fstatat64(int, const char *, void *, int) __asm("_fstatat64");
WEAK extern int sys_statx_np(const char *, void *, void *) __asm(STATX_NP_SYMBOL);
WEAK extern int sys_lstatx_np(const char *, void *, void *) __asm(LSTATX_NP_SYMBOL);
WEAK extern int sys_getattrlist(const char *, void *, void *, size_t, unsigned int) __asm("_getattrlist");
WEAK extern int sys_getattrlistat(int, const char *, void *, void *, size_t, unsigned long) __asm("_getattrlistat");
WEAK extern int sys_getattrlistbulk(int, void *, void *, size_t, uint64_t) __asm("_getattrlistbulk");
WEAK extern ssize_t sys_getdirentries64(int, void *, size_t, off_t *) __asm("___getdirentries64");
WEAK extern int sys_getdirentries(int, char *, int, long *) __asm("_getdirentries");
WEAK extern int sys_getdirentriesattr(int, void *, void *, size_t, unsigned int *, unsigned int *, unsigned int *,
                                 unsigned int) __asm("_getdirentriesattr");
WEAK extern int sys_renamex_np(const char *, const char *, unsigned int) __asm("_renamex_np");
WEAK extern int sys_renameatx_np(int, const char *, int, const char *, unsigned int) __asm("_renameatx_np");
WEAK extern int sys_clonefile(const char *, const char *, uint32_t) __asm("_clonefile");
WEAK extern int sys_clonefileat(int, const char *, int, const char *, uint32_t) __asm("_clonefileat");
WEAK extern int sys_fclonefileat(int, int, const char *, uint32_t) __asm("_fclonefileat");
WEAK extern int sys_exchangedata(const char *, const char *, unsigned int) __asm("_exchangedata");
WEAK extern int sys_connect_nocancel(int, const struct sockaddr *, socklen_t) __asm("_connect$NOCANCEL");
WEAK extern int sys_connectx(int, const sa_endpoints_t *, uint32_t, unsigned int, const void *, unsigned int, size_t *,
                        uint32_t *) __asm("_connectx");
WEAK extern int sys_syscall(int, ...) __asm("_syscall");
#if defined(__x86_64__)
/* 32-bit-inode versions, which programs built for macOS before 10.6 still call. */
WEAK extern int sys_stat_legacy(const char *, void *) __asm("_stat");
WEAK extern int sys_lstat_legacy(const char *, void *) __asm("_lstat");
WEAK extern int sys_fstatat_legacy(int, const char *, void *, int) __asm("_fstatat");
WEAK extern char *sys_realpath_legacy(const char *, char *) __asm("_realpath");
#endif

#define INTERPOSE(replacement, original)                                                                  \
  __attribute__((used)) static const struct {                                                             \
    const void *with;                                                                                     \
    const void *what;                                                                                     \
  } interpose_##replacement __attribute__((section("__DATA,__interpose"))) = {(const void *)&replacement, \
                                                                               (const void *)&original}

/* ---- the log ------------------------------------------------------------------------------------ */

static int log_fd = -1;
static dev_t log_dev;
static ino_t log_ino;
static int initialized;
static char trace_value[PATH_MAX];
/* "VEYRUM_TRACE=<log>", restored for programs that remove it. */
static char trace_entry[PATH_MAX + 16];
/* This library's file, and the run's directory of shadow copies (next to the log). */
static char own_path[PATH_MAX];
static char shadow_dir[PATH_MAX];
static int host_arm64;

/* Descriptors from here up are unlikely to be chosen by the program for its own purposes. */
#define LOG_FD_FLOOR 900
#define LOG_FD_FALLBACK 180

static const char *env_lookup(char *const envp[], const char *name) {
  size_t len = strlen(name);
  for (char *const *e = envp; e && *e; e++)
    if (strncmp(*e, name, len) == 0 && (*e)[len] == '=') return *e + len + 1;
  return NULL;
}

static int log_open(void) {
  int fd = open(trace_value, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0600);
  if (fd < 0) return -1;
  int high = fcntl(fd, F_DUPFD_CLOEXEC, LOG_FD_FLOOR);
  if (high < 0) high = fcntl(fd, F_DUPFD_CLOEXEC, LOG_FD_FALLBACK);
  if (high >= 0) {
    close(fd);
    fd = high;
  }
  struct stat st;
  if (fstat(fd, &st) != 0) {
    close(fd);
    return -1;
  }
  log_dev = st.st_dev;
  log_ino = st.st_ino;
  return fd;
}

static const void *strip(const void *p) {
#if __has_feature(ptrauth_calls)
  return ptrauth_strip(p, ptrauth_key_function_pointer);
#else
  return p;
#endif
}

static void init(void) {
  if (initialized) return;
  initialized = 1;
  int one = 0;
  size_t size = sizeof one;
  host_arm64 = sysctlbyname("hw.optional.arm64", &one, &size, NULL, 0) == 0 && one == 1;
  Dl_info info;
  if (dladdr(strip((const void *)&init), &info) && info.dli_fname && strlen(info.dli_fname) < sizeof own_path)
    strcpy(own_path, info.dli_fname);
  const char *trace = env_lookup(environ, "VEYRUM_TRACE");
  if (!trace || !*trace || strlen(trace) >= sizeof trace_value - 16 || !own_path[0]) return;
  strcpy(trace_value, trace);
  strcpy(trace_entry, "VEYRUM_TRACE=");
  strcat(trace_entry, trace_value);
  const char *slash = strrchr(trace_value, '/');
  if (slash && slash != trace_value) {
    memcpy(shadow_dir, trace_value, (size_t)(slash - trace_value));
    strcpy(shadow_dir + (slash - trace_value), "/shadow");
  }
  log_fd = log_open();
}

/* Whether this process is traced. libSystem opens files before this library's initializer runs. */
static int tracing(void) {
  if (!initialized) init();
  return log_fd >= 0;
}

/* A line of the log, built without the printf family. */
struct line {
  char buf[PATH_MAX * 2 + 64];
  size_t len;
  int overflow;
};

static void put(struct line *l, const char *s) {
  size_t n = strlen(s);
  if (l->len + n >= sizeof l->buf - 1) {
    l->overflow = 1;
    return;
  }
  memcpy(l->buf + l->len, s, n);
  l->len += n;
}

static void put_char(struct line *l, char c) {
  char s[2] = {c, '\0'};
  put(l, s);
}

static void put_number(struct line *l, unsigned long long v, unsigned base) {
  char digits[24];
  size_t i = sizeof digits;
  digits[--i] = '\0';
  do {
    digits[--i] = "0123456789abcdef"[v % base];
    v /= base;
  } while (v);
  put(l, digits + i);
}

/* Consecutive identical lines (a directory read in batches) are written once. */
static uint64_t last_line;

static void log_write(const char *buf, size_t len) {
  uint64_t h = 1469598103934665603ULL;
  for (size_t i = 0; i < len; i++) h = (h ^ (unsigned char)buf[i]) * 1099511628211ULL;
  if (h == last_line) return;
  /* A program can reuse the log's descriptor number (dup2, a shell's redirection): check it is still the log. */
  struct stat st;
  if (fstat(log_fd, &st) != 0 || st.st_dev != log_dev || st.st_ino != log_ino) {
    int fd = log_open();
    if (fd < 0) return;
    log_fd = fd;
  }
  if (write(log_fd, buf, len) == (ssize_t)len) last_line = h;
}

static void emit_raw(const char *text) {
  if (tracing()) log_write(text, strlen(text));
}

/* The working directory, from the kernel: needs no descriptor and no permission to read it. */
static int cwd_path(char *out) {
  struct proc_vnodepathinfo info;
  if (proc_pidinfo(getpid(), PROC_PIDVNODEPATHINFO, 0, &info, sizeof info) == (int)sizeof info &&
      info.pvi_cdir.vip_path[0] == '/') {
    strlcpy(out, info.pvi_cdir.vip_path, MAXPATHLEN);
    return 0;
  }
  int fd = open(".", O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  int r = fcntl(fd, F_GETPATH, out);
  close(fd);
  return r == -1 ? -1 : 0;
}

/* Directory a relative path is resolved against: the working directory, or the dirfd's. */
static int base_dir(int dirfd, char *out) {
  if (dirfd == AT_FDCWD) return cwd_path(out);
  return fcntl(dirfd, F_GETPATH, out) == -1 ? -1 : 0;
}

static void emit_at(char kind, int dirfd, const char *path) {
  if (!tracing() || !path || !*path) return;
  int saved = errno;
  struct line l = {.len = 0, .overflow = 0};
  put_char(&l, kind);
  put_char(&l, ' ');
  if (path[0] != '/') {
    char dir[MAXPATHLEN];
    if (base_dir(dirfd, dir) != 0) {
      emit_raw("u unresolvable path\n");
      errno = saved;
      return;
    }
    put(&l, dir);
    if (l.len && l.buf[l.len - 1] != '/') put_char(&l, '/');
  }
  put(&l, path);
  /* A path that does not fit, or that contains a newline, cannot be recorded faithfully. */
  if (l.overflow || strchr(path, '\n')) {
    emit_raw("u unrecordable path\n");
  } else {
    put_char(&l, '\n');
    log_write(l.buf, l.len);
  }
  errno = saved;
}

static void emit(char kind, const char *path) { emit_at(kind, AT_FDCWD, path); }

/* A descriptor's directory was listed. */
static void listed(int fd) {
  if (!tracing()) return;
  int saved = errno;
  char dir[MAXPATHLEN];
  if (fcntl(fd, F_GETPATH, dir) != -1) emit('d', dir);
  else emit_raw("u directory listing\n");
  errno = saved;
}

/* ---- opening files ------------------------------------------------------------------------------ */

static int wants_write(int flags) { return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) != 0; }

/*
 * Opening a directory only shows that it exists (the reader treats a read of a directory as a
 * status check); reading its entries is what lists it. O_EVTONLY opens for change notifications.
 */
static void opened(int dirfd, const char *path, int flags, int result, int error) {
  if (!tracing()) return;
  if (result >= 0 && (flags & O_EVTONLY)) {
    emit_at('s', dirfd, path);
  } else if (result >= 0) {
    /* O_RDWR reads too: record the read before the write. */
    if ((flags & O_ACCMODE) != O_WRONLY) emit_at('r', dirfd, path);
    if (wants_write(flags)) emit_at('w', dirfd, path);
  } else if (error == ENOENT || error == ENOTDIR) {
    emit_at(wants_write(flags) ? 'w' : 'R', dirfd, path);
  }
  errno = error;
}

#define MODE_ARG(flags)                                         \
  int mode = 0;                                                 \
  if ((flags) & O_CREAT) {                                      \
    va_list ap;                                                 \
    va_start(ap, flags);                                        \
    mode = va_arg(ap, int);                                     \
    va_end(ap);                                                 \
  }

static int v_open(const char *path, int flags, ...) {
  MODE_ARG(flags)
  int r = open(path, flags, mode);
  opened(AT_FDCWD, path, flags, r, errno);
  return r;
}
INTERPOSE(v_open, open);

static int v_open_nocancel(const char *path, int flags, ...) {
  MODE_ARG(flags)
  int r = sys_open_nocancel(path, flags, mode);
  opened(AT_FDCWD, path, flags, r, errno);
  return r;
}
INTERPOSE(v_open_nocancel, sys_open_nocancel);

static int v_openat(int dirfd, const char *path, int flags, ...) {
  MODE_ARG(flags)
  int r = openat(dirfd, path, flags, mode);
  opened(dirfd, path, flags, r, errno);
  return r;
}
INTERPOSE(v_openat, openat);

static int v_openat_nocancel(int dirfd, const char *path, int flags, ...) {
  MODE_ARG(flags)
  int r = sys_openat_nocancel(dirfd, path, flags, mode);
  opened(dirfd, path, flags, r, errno);
  return r;
}
INTERPOSE(v_openat_nocancel, sys_openat_nocancel);

/* The system call stubs themselves take the mode as a plain argument. */
static int v___open_nocancel(const char *path, int flags, int mode) {
  int r = sys___open_nocancel(path, flags, mode);
  opened(AT_FDCWD, path, flags, r, errno);
  return r;
}
INTERPOSE(v___open_nocancel, sys___open_nocancel);

static int v___openat_nocancel(int dirfd, const char *path, int flags, int mode) {
  int r = sys___openat_nocancel(dirfd, path, flags, mode);
  opened(dirfd, path, flags, r, errno);
  return r;
}
INTERPOSE(v___openat_nocancel, sys___openat_nocancel);

static int v_open_dprotected_np(const char *path, int flags, int class, int dpflags, ...) {
  int mode = 0;
  if (flags & O_CREAT) {
    va_list ap;
    va_start(ap, dpflags);
    mode = va_arg(ap, int);
    va_end(ap);
  }
  int r = sys_open_dprotected_np(path, flags, class, dpflags, mode);
  opened(AT_FDCWD, path, flags, r, errno);
  return r;
}
INTERPOSE(v_open_dprotected_np, sys_open_dprotected_np);

static int v_openat_dprotected_np(int dirfd, const char *path, int flags, int class, int dpflags, ...) {
  int mode = 0;
  if (flags & O_CREAT) {
    va_list ap;
    va_start(ap, dpflags);
    mode = va_arg(ap, int);
    va_end(ap);
  }
  int r = sys_openat_dprotected_np(dirfd, path, flags, class, dpflags, mode);
  opened(dirfd, path, flags, r, errno);
  return r;
}
INTERPOSE(v_openat_dprotected_np, sys_openat_dprotected_np);

static int v_guarded_open_np(const char *path, const uint64_t *guard, unsigned int guardflags, int flags, ...) {
  MODE_ARG(flags)
  int r = sys_guarded_open_np(path, guard, guardflags, flags, mode);
  opened(AT_FDCWD, path, flags, r, errno);
  return r;
}
INTERPOSE(v_guarded_open_np, sys_guarded_open_np);

static int v_guarded_open_dprotected_np(const char *path, const uint64_t *guard, unsigned int guardflags,
                                        int flags, int class, int dpflags, ...) {
  int mode = 0;
  if (flags & O_CREAT) {
    va_list ap;
    va_start(ap, dpflags);
    mode = va_arg(ap, int);
    va_end(ap);
  }
  int r = sys_guarded_open_dprotected_np(path, guard, guardflags, flags, class, dpflags, mode);
  opened(AT_FDCWD, path, flags, r, errno);
  return r;
}
INTERPOSE(v_guarded_open_dprotected_np, sys_guarded_open_dprotected_np);

static int v_openx_np(const char *path, int flags, void *security) {
  int r = sys_openx_np(path, flags, security);
  opened(AT_FDCWD, path, flags, r, errno);
  return r;
}
INTERPOSE(v_openx_np, sys_openx_np);

/* Opening a file by its file-system identifiers names no path. */
static int v_openbyid_np(void *fsid, void *objid, int flags) {
  emit_raw("u openbyid_np\n");
  return sys_openbyid_np(fsid, objid, flags);
}
INTERPOSE(v_openbyid_np, sys_openbyid_np);

/* ---- status checks ------------------------------------------------------------------------------ */

static void checked(int dirfd, const char *path, int present, int error) {
  if (present) emit_at('s', dirfd, path);
  else if (error == ENOENT || error == ENOTDIR) emit_at('S', dirfd, path);
  errno = error;
}

#define STAT_LIKE(name, call, buf_type)                  \
  static int name(const char *path, buf_type buf) {      \
    int r = call(path, buf);                             \
    checked(AT_FDCWD, path, r == 0, errno);              \
    return r;                                            \
  }

STAT_LIKE(v_stat, stat, struct stat *)
INTERPOSE(v_stat, stat);
STAT_LIKE(v_lstat, lstat, struct stat *)
INTERPOSE(v_lstat, lstat);
STAT_LIKE(v_stat64, sys_stat64, void *)
INTERPOSE(v_stat64, sys_stat64);
STAT_LIKE(v_lstat64, sys_lstat64, void *)
INTERPOSE(v_lstat64, sys_lstat64);
#if defined(__x86_64__)
STAT_LIKE(v_stat_legacy, sys_stat_legacy, void *)
INTERPOSE(v_stat_legacy, sys_stat_legacy);
STAT_LIKE(v_lstat_legacy, sys_lstat_legacy, void *)
INTERPOSE(v_lstat_legacy, sys_lstat_legacy);
#endif

static int v_fstatat(int dirfd, const char *path, struct stat *buf, int flags) {
  int r = fstatat(dirfd, path, buf, flags);
  checked(dirfd, path, r == 0, errno);
  return r;
}
INTERPOSE(v_fstatat, fstatat);

static int v_fstatat64(int dirfd, const char *path, void *buf, int flags) {
  int r = sys_fstatat64(dirfd, path, buf, flags);
  checked(dirfd, path, r == 0, errno);
  return r;
}
INTERPOSE(v_fstatat64, sys_fstatat64);

#if defined(__x86_64__)
static int v_fstatat_legacy(int dirfd, const char *path, void *buf, int flags) {
  int r = sys_fstatat_legacy(dirfd, path, buf, flags);
  checked(dirfd, path, r == 0, errno);
  return r;
}
INTERPOSE(v_fstatat_legacy, sys_fstatat_legacy);
#endif

static int v_statx_np(const char *path, void *buf, void *security) {
  int r = sys_statx_np(path, buf, security);
  checked(AT_FDCWD, path, r == 0, errno);
  return r;
}
INTERPOSE(v_statx_np, sys_statx_np);

static int v_lstatx_np(const char *path, void *buf, void *security) {
  int r = sys_lstatx_np(path, buf, security);
  checked(AT_FDCWD, path, r == 0, errno);
  return r;
}
INTERPOSE(v_lstatx_np, sys_lstatx_np);

/* A permission check that fails for another reason than absence still shows the path exists. */
static int v_access(const char *path, int mode) {
  int r = access(path, mode);
  checked(AT_FDCWD, path, r == 0 || errno != ENOENT, errno);
  return r;
}
INTERPOSE(v_access, access);

static int v_faccessat(int dirfd, const char *path, int mode, int flags) {
  int r = faccessat(dirfd, path, mode, flags);
  checked(dirfd, path, r == 0 || errno != ENOENT, errno);
  return r;
}
INTERPOSE(v_faccessat, faccessat);

static int v_getattrlist(const char *path, void *list, void *buf, size_t size, unsigned int options) {
  int r = sys_getattrlist(path, list, buf, size, options);
  checked(AT_FDCWD, path, r == 0, errno);
  return r;
}
INTERPOSE(v_getattrlist, sys_getattrlist);

static int v_getattrlistat(int dirfd, const char *path, void *list, void *buf, size_t size, unsigned long options) {
  int r = sys_getattrlistat(dirfd, path, list, buf, size, options);
  checked(dirfd, path, r == 0, errno);
  return r;
}
INTERPOSE(v_getattrlistat, sys_getattrlistat);

static void link_read(int dirfd, const char *path, ssize_t r, int error) {
  emit_at(r >= 0 ? 'r' : (error == ENOENT || error == ENOTDIR ? 'R' : 's'), dirfd, path);
  errno = error;
}

static ssize_t v_readlink(const char *path, char *buf, size_t size) {
  ssize_t r = readlink(path, buf, size);
  link_read(AT_FDCWD, path, r, errno);
  return r;
}
INTERPOSE(v_readlink, readlink);

static ssize_t v_readlinkat(int dirfd, const char *path, char *buf, size_t size) {
  ssize_t r = readlinkat(dirfd, path, buf, size);
  link_read(dirfd, path, r, errno);
  return r;
}
INTERPOSE(v_readlinkat, readlinkat);

/* realpath's result depends on every symbolic link on the way (seen as it checks them, too). */
static void resolved(const char *path, const char *r, int error) {
  if (r) {
    emit('s', path);
    emit('s', r);
  } else if (error == ENOENT || error == ENOTDIR) {
    emit('S', path);
  } else if (error != EINVAL) {
    emit_raw("u realpath\n");
  }
  errno = error;
}

static char *v_realpath(const char *path, char *out) {
  char *r = realpath(path, out);
  resolved(path, r, errno);
  return r;
}
INTERPOSE(v_realpath, realpath);

#if defined(__x86_64__)
static char *v_realpath_legacy(const char *path, char *out) {
  char *r = sys_realpath_legacy(path, out);
  resolved(path, r, errno);
  return r;
}
INTERPOSE(v_realpath_legacy, sys_realpath_legacy);
#endif

/* ---- directories -------------------------------------------------------------------------------- */

static ssize_t v_getdirentries64(int fd, void *buf, size_t size, off_t *base) {
  ssize_t r = sys_getdirentries64(fd, buf, size, base);
  int error = errno;
  if (r >= 0) listed(fd);
  errno = error;
  return r;
}
INTERPOSE(v_getdirentries64, sys_getdirentries64);

static int v_getdirentries(int fd, char *buf, int size, long *base) {
  int r = sys_getdirentries(fd, buf, size, base);
  int error = errno;
  if (r >= 0) listed(fd);
  errno = error;
  return r;
}
INTERPOSE(v_getdirentries, sys_getdirentries);

static int v_getattrlistbulk(int fd, void *list, void *buf, size_t size, uint64_t options) {
  int r = sys_getattrlistbulk(fd, list, buf, size, options);
  int error = errno;
  if (r >= 0) listed(fd);
  errno = error;
  return r;
}
INTERPOSE(v_getattrlistbulk, sys_getattrlistbulk);

static int v_getdirentriesattr(int fd, void *list, void *buf, size_t size, unsigned int *count, unsigned int *base,
                               unsigned int *state, unsigned int options) {
  int r = sys_getdirentriesattr(fd, list, buf, size, count, base, state, options);
  int error = errno;
  if (r >= 0) listed(fd);
  errno = error;
  return r;
}
INTERPOSE(v_getdirentriesattr, sys_getdirentriesattr);

/* ---- writes ------------------------------------------------------------------------------------- */

#define WRITE_AFTER(call, ...)          \
  int r = call;                         \
  int error = errno;                    \
  __VA_ARGS__;                          \
  errno = error;                        \
  return r

static int v_unlink(const char *path) { WRITE_AFTER(unlink(path), emit('w', path)); }
INTERPOSE(v_unlink, unlink);
static int v_rmdir(const char *path) { WRITE_AFTER(rmdir(path), emit('w', path)); }
INTERPOSE(v_rmdir, rmdir);
static int v_unlinkat(int dirfd, const char *path, int flags) {
  WRITE_AFTER(unlinkat(dirfd, path, flags), emit_at('w', dirfd, path));
}
INTERPOSE(v_unlinkat, unlinkat);
static int v_mkdir(const char *path, mode_t mode) { WRITE_AFTER(mkdir(path, mode), emit('w', path)); }
INTERPOSE(v_mkdir, mkdir);
static int v_mkdirat(int dirfd, const char *path, mode_t mode) {
  WRITE_AFTER(mkdirat(dirfd, path, mode), emit_at('w', dirfd, path));
}
INTERPOSE(v_mkdirat, mkdirat);
static int v_rename(const char *from, const char *to) {
  WRITE_AFTER(rename(from, to), emit('w', from); emit('w', to));
}
INTERPOSE(v_rename, rename);
static int v_renameat(int fromfd, const char *from, int tofd, const char *to) {
  WRITE_AFTER(renameat(fromfd, from, tofd, to), emit_at('w', fromfd, from); emit_at('w', tofd, to));
}
INTERPOSE(v_renameat, renameat);
static int v_renamex_np(const char *from, const char *to, unsigned int flags) {
  WRITE_AFTER(sys_renamex_np(from, to, flags), emit('w', from); emit('w', to));
}
INTERPOSE(v_renamex_np, sys_renamex_np);
static int v_renameatx_np(int fromfd, const char *from, int tofd, const char *to, unsigned int flags) {
  WRITE_AFTER(sys_renameatx_np(fromfd, from, tofd, to, flags), emit_at('w', fromfd, from);
              emit_at('w', tofd, to));
}
INTERPOSE(v_renameatx_np, sys_renameatx_np);
static int v_exchangedata(const char *a, const char *b, unsigned int options) {
  WRITE_AFTER(sys_exchangedata(a, b, options), emit('w', a); emit('w', b));
}
INTERPOSE(v_exchangedata, sys_exchangedata);
static int v_link(const char *from, const char *to) {
  WRITE_AFTER(link(from, to), emit('r', from); emit('w', to));
}
INTERPOSE(v_link, link);
static int v_linkat(int fromfd, const char *from, int tofd, const char *to, int flags) {
  WRITE_AFTER(linkat(fromfd, from, tofd, to, flags), emit_at('r', fromfd, from); emit_at('w', tofd, to));
}
INTERPOSE(v_linkat, linkat);
static int v_clonefile(const char *from, const char *to, uint32_t flags) {
  WRITE_AFTER(sys_clonefile(from, to, flags), emit('r', from); emit('w', to));
}
INTERPOSE(v_clonefile, sys_clonefile);
static int v_clonefileat(int fromfd, const char *from, int tofd, const char *to, uint32_t flags) {
  WRITE_AFTER(sys_clonefileat(fromfd, from, tofd, to, flags), emit_at('r', fromfd, from); emit_at('w', tofd, to));
}
INTERPOSE(v_clonefileat, sys_clonefileat);
static int v_fclonefileat(int fromfd, int tofd, const char *to, uint32_t flags) {
  WRITE_AFTER(sys_fclonefileat(fromfd, tofd, to, flags), emit_at('w', tofd, to));
}
INTERPOSE(v_fclonefileat, sys_fclonefileat);
static int v_symlink(const char *target, const char *path) {
  WRITE_AFTER(symlink(target, path), emit('w', path));
}
INTERPOSE(v_symlink, symlink);
static int v_symlinkat(const char *target, int dirfd, const char *path) {
  WRITE_AFTER(symlinkat(target, dirfd, path), emit_at('w', dirfd, path));
}
INTERPOSE(v_symlinkat, symlinkat);
static int v_truncate(const char *path, off_t length) { WRITE_AFTER(truncate(path, length), emit('w', path)); }
INTERPOSE(v_truncate, truncate);
static int v_mkfifo(const char *path, mode_t mode) { WRITE_AFTER(mkfifo(path, mode), emit('w', path)); }
INTERPOSE(v_mkfifo, mkfifo);
static int v_mknod(const char *path, mode_t mode, dev_t dev) { WRITE_AFTER(mknod(path, mode, dev), emit('w', path)); }
INTERPOSE(v_mknod, mknod);

/* ---- raw system calls --------------------------------------------------------------------------- */

/*
 * syscall(2), deprecated but still exported: the file-system calls among its uses are recorded
 * like their functions; an exec this way cannot keep the tracer and is untraceable. Its arguments
 * are read as eight words, as many as any system call takes.
 */
static int v_syscall(int number, ...) {
  va_list ap;
  va_start(ap, number);
  long a[8];
  for (int i = 0; i < 8; i++) a[i] = va_arg(ap, long);
  va_end(ap);
  if (number == SYS_execve || number == SYS_posix_spawn) emit_raw("u raw exec\n");
  int r = sys_syscall(number, a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]);
  int error = errno;
  switch (number) {
    case SYS_open:
    case SYS_open_nocancel:
      opened(AT_FDCWD, (const char *)a[0], (int)a[1], r, error);
      break;
    case SYS_openat:
    case SYS_openat_nocancel:
      opened((int)a[0], (const char *)a[1], (int)a[2], r, error);
      break;
    case SYS_stat:
    case SYS_lstat:
    case SYS_stat64:
    case SYS_lstat64:
    case SYS_getattrlist:
      checked(AT_FDCWD, (const char *)a[0], r == 0, error);
      break;
    case SYS_access:
      checked(AT_FDCWD, (const char *)a[0], r == 0 || error != ENOENT, error);
      break;
    case SYS_fstatat:
    case SYS_fstatat64:
      checked((int)a[0], (const char *)a[1], r == 0, error);
      break;
    case SYS_faccessat:
      checked((int)a[0], (const char *)a[1], r == 0 || error != ENOENT, error);
      break;
    case SYS_readlink:
      link_read(AT_FDCWD, (const char *)a[0], r, error);
      break;
    case SYS_readlinkat:
      link_read((int)a[0], (const char *)a[1], r, error);
      break;
    case SYS_getdirentries:
    case SYS_getdirentries64:
    case SYS_getattrlistbulk:
      if (r >= 0) listed((int)a[0]);
      break;
    case SYS_unlink:
    case SYS_rmdir:
    case SYS_mkdir:
    case SYS_truncate:
      emit('w', (const char *)a[0]);
      break;
    case SYS_rename:
      emit('w', (const char *)a[0]);
      emit('w', (const char *)a[1]);
      break;
    case SYS_unlinkat:
    case SYS_mkdirat:
      emit_at('w', (int)a[0], (const char *)a[1]);
      break;
    default:
      break;
  }
  errno = error;
  return r;
}
INTERPOSE(v_syscall, sys_syscall);

/* ---- libraries ---------------------------------------------------------------------------------- */

static void *(*dlopen_from_fn)(const char *, int, void *);

/*
 * dlopen resolves @loader_path and @rpath against the caller: calling it from here would resolve
 * them against this library, so the caller is passed on (dlopen_from, which dlopen itself is).
 */
static void *v_dlopen(const char *path, int mode) {
  const void *caller = strip(__builtin_return_address(0));
  void *h = dlopen_from_fn ? dlopen_from_fn(path, mode, (void *)caller) : dlopen(path, mode);
  /* A bare name is found by dyld among system libraries; loaded ones are recorded when added. */
  if (path && path[0] != '@' && strchr(path, '/') && !h) emit('R', path);
  return h;
}
INTERPOSE(v_dlopen, dlopen);

/* Every image loaded from a file: the program's own libraries and plugins are inputs. */
static void image_added(const struct mach_header *mh, intptr_t slide) {
  (void)slide;
  if (!mh || (mh->flags & MH_DYLIB_IN_CACHE) || mh->filetype == MH_EXECUTE || !tracing()) return;
  Dl_info info;
  if (!dladdr(mh, &info) || !info.dli_fname || strcmp(info.dli_fname, own_path) == 0) return;
  emit('r', info.dli_fname);
}

/* ---- network ------------------------------------------------------------------------------------ */

static void put_ipv6(struct line *l, const uint8_t *a) {
  uint16_t g[8];
  for (int i = 0; i < 8; i++) g[i] = (uint16_t)(a[2 * i] << 8 | a[2 * i + 1]);
  /* An IPv4-mapped address, written as inet_ntop writes it. */
  if (!g[0] && !g[1] && !g[2] && !g[3] && !g[4] && g[5] == 0xffff) {
    put(l, "::ffff:");
    for (int i = 12; i < 16; i++) {
      put_number(l, a[i], 10);
      if (i < 15) put_char(l, '.');
    }
    return;
  }
  /* The longest run of two or more zero groups is written as "::" (RFC 5952). */
  int best = -1, best_len = 0;
  for (int i = 0; i < 8;) {
    if (g[i]) {
      i++;
      continue;
    }
    int j = i;
    while (j < 8 && !g[j]) j++;
    if (j - i > best_len && j - i >= 2) {
      best = i;
      best_len = j - i;
    }
    i = j;
  }
  for (int i = 0; i < 8; i++) {
    if (i == best) {
      put(l, "::");
      i += best_len - 1;
      continue;
    }
    if (i && i != best + best_len) put_char(l, ':');
    put_number(l, g[i], 16);
  }
}

/* Every connection attempt is recorded: a failed one depends on the network too. */
static void connected(const struct sockaddr *addr, socklen_t len) {
  if (!addr || !tracing() || len < (socklen_t)sizeof(sa_family_t) + 1) return;
  int saved = errno;
  struct line l = {.len = 0, .overflow = 0};
  put(&l, "n ");
  if (addr->sa_family == AF_INET && len >= (socklen_t)sizeof(struct sockaddr_in)) {
    const struct sockaddr_in *in = (const struct sockaddr_in *)addr;
    const uint8_t *b = (const uint8_t *)&in->sin_addr;
    for (int i = 0; i < 4; i++) {
      put_number(&l, b[i], 10);
      if (i < 3) put_char(&l, '.');
    }
    put_char(&l, ' ');
    put_number(&l, ntohs(in->sin_port), 10);
  } else if (addr->sa_family == AF_INET6 && len >= (socklen_t)sizeof(struct sockaddr_in6)) {
    const struct sockaddr_in6 *in6 = (const struct sockaddr_in6 *)addr;
    put_ipv6(&l, (const uint8_t *)&in6->sin6_addr);
    put_char(&l, ' ');
    put_number(&l, ntohs(in6->sin6_port), 10);
  } else if (addr->sa_family == AF_UNIX) {
    /* Treated like the test's own Unix socket connections: local. */
    const struct sockaddr_un *un = (const struct sockaddr_un *)addr;
    char p[sizeof un->sun_path + 1];
    size_t n = len > offsetof(struct sockaddr_un, sun_path) ? len - offsetof(struct sockaddr_un, sun_path) : 0;
    if (n > sizeof un->sun_path) n = sizeof un->sun_path;
    memcpy(p, un->sun_path, n);
    p[n] = '\0';
    put(&l, "unix:");
    put(&l, p[0] && !strchr(p, '\n') ? p : "unnamed");
    put(&l, " 0");
  } else {
    errno = saved;
    return;
  }
  put_char(&l, '\n');
  if (!l.overflow) log_write(l.buf, l.len);
  errno = saved;
}

static int v_connect(int fd, const struct sockaddr *addr, socklen_t len) {
  connected(addr, len);
  return connect(fd, addr, len);
}
INTERPOSE(v_connect, connect);

static int v_connect_nocancel(int fd, const struct sockaddr *addr, socklen_t len) {
  connected(addr, len);
  return sys_connect_nocancel(fd, addr, len);
}
INTERPOSE(v_connect_nocancel, sys_connect_nocancel);

static int v_connectx(int fd, const sa_endpoints_t *ep, uint32_t assoc, unsigned int flags, const void *iov,
                      unsigned int iovcnt, size_t *len, uint32_t *conn) {
  if (ep) connected(ep->sae_dstaddr, ep->sae_dstaddrlen);
  return sys_connectx(fd, ep, assoc, flags, iov, iovcnt, len, conn);
}
INTERPOSE(v_connectx, sys_connectx);

/* ---- programs ----------------------------------------------------------------------------------- */

#define CSMAGIC_EMBEDDED_SIGNATURE 0xfade0cc0u
#define CSMAGIC_CODEDIRECTORY 0xfade0c02u
#define CSMAGIC_EMBEDDED_ENTITLEMENTS 0xfade7171u
#define CSSLOT_CODEDIRECTORY 0u
#define CSSLOT_ENTITLEMENTS 5u
#define CS_RESTRICT 0x800u
#define CS_REQUIRE_LV 0x2000u
#define CS_RUNTIME 0x10000u
#define CPU_ARCH_ABI64_ 0x01000000
#define CPU_TYPE_X86_64_ (7 | CPU_ARCH_ABI64_)
#define CPU_TYPE_ARM64_ (12 | CPU_ARCH_ABI64_)
#define CPU_SUBTYPE_ARM64E_ 2
#define MAX_SCRIPT_ARGS 16

static uint32_t be32(const unsigned char *p) {
  return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3];
}
static uint32_t le32(const unsigned char *p) {
  return (uint32_t)p[3] << 24 | (uint32_t)p[2] << 16 | (uint32_t)p[1] << 8 | p[0];
}
static uint64_t be64(const unsigned char *p) { return (uint64_t)be32(p) << 32 | be32(p + 4); }

static int read_at(int fd, void *buf, size_t size, off_t offset) {
  return pread(fd, buf, size, offset) == (ssize_t)size ? 0 : -1;
}

/* What an exec would run, as far as tracing goes. */
struct program {
  enum { PROGRAM_MISSING, PROGRAM_OTHER, PROGRAM_SCRIPT, PROGRAM_MACHO } kind;
  struct stat st;
  /* Mach-O: dyld would not load this library into it, or loading it would kill the program. */
  int protected;
  /* Mach-O: nothing makes it traceable (set-user-ID, a __RESTRICT segment). */
  int untraceable;
  /* Mach-O: it runs as arm64e, so its shadow copy is an ad hoc arm64e program. */
  int arm64e;
  /*
   * Mach-O: it finds libraries or resources relative to its own file (@executable_path,
   * @loader_path, an application bundle), which a copy elsewhere would not find.
   */
  int located;
  /* Script: the interpreter and its arguments, split as the kernel splits them. */
  char line[256];
  char *interpreter;
  char *args[MAX_SCRIPT_ARGS];
  int nargs;
};

static int entitled(const char *xml, size_t len, const char *key) {
  size_t klen = strlen(key);
  for (size_t i = 0; i + klen < len; i++) {
    if (memcmp(xml + i, key, klen) != 0) continue;
    size_t j = i + klen;
    if (j + 6 > len || memcmp(xml + j, "</key>", 6) != 0) continue;
    j += 6;
    while (j < len && (xml[j] == ' ' || xml[j] == '\t' || xml[j] == '\n' || xml[j] == '\r')) j++;
    return j + 7 <= len && memcmp(xml + j, "<true/>", 7) == 0;
  }
  return 0;
}

/* Reads the code signature of the Mach-O image at `base`: whether dyld would inject into it. */
static void inspect_image(int fd, off_t base, const char *path, struct program *p) {
  unsigned char header[32];
  if (read_at(fd, header, sizeof header, base) || le32(header) != MH_MAGIC_64) return;
  uint32_t ncmds = le32(header + 16);
  off_t at = base + (off_t)sizeof header;
  uint32_t sig_off = 0, sig_size = 0;
  for (uint32_t i = 0; i < ncmds && i < 4096; i++) {
    unsigned char lc[24];
    if (read_at(fd, lc, sizeof lc, at)) return;
    uint32_t cmd = le32(lc), size = le32(lc + 4);
    if (size < 8) return;
    if (cmd == LC_CODE_SIGNATURE) {
      sig_off = le32(lc + 8);
      sig_size = le32(lc + 12);
    } else if (cmd == LC_SEGMENT_64 && memcmp(lc + 8, "__RESTRICT\0", 11) == 0) {
      /* dyld ignores DYLD_* variables for such a program, copied or not. */
      p->untraceable = 1;
    } else if (cmd == LC_LOAD_DYLIB || cmd == LC_LOAD_WEAK_DYLIB || cmd == LC_REEXPORT_DYLIB ||
               cmd == LC_LAZY_LOAD_DYLIB || cmd == LC_LOAD_UPWARD_DYLIB || cmd == LC_RPATH) {
      /* The library's path or the search path, at the offset the command gives. */
      uint32_t name = le32(lc + 8);
      char prefix[13];
      if (name < size && !read_at(fd, prefix, sizeof prefix, at + name) &&
          (memcmp(prefix, "@executable_", 12) == 0 || memcmp(prefix, "@loader_path", 12) == 0))
        p->located = 1;
    }
    at += size;
  }
  if (!sig_off || sig_size < 12) return;
  off_t sig = base + sig_off;
  unsigned char blob[12];
  if (read_at(fd, blob, sizeof blob, sig) || be32(blob) != CSMAGIC_EMBEDDED_SIGNATURE) return;
  uint32_t count = be32(blob + 8), flags = 0;
  int platform = 0, allow_dyld = 0, disable_lv = 0;
  for (uint32_t i = 0; i < count && i < 64; i++) {
    unsigned char entry[8];
    if (read_at(fd, entry, sizeof entry, sig + 12 + 8 * (off_t)i)) return;
    uint32_t type = be32(entry), offset = be32(entry + 4);
    if (type == CSSLOT_CODEDIRECTORY) {
      unsigned char cd[40];
      if (read_at(fd, cd, sizeof cd, sig + offset) || be32(cd) != CSMAGIC_CODEDIRECTORY) return;
      flags = be32(cd + 12);
      /* Apple's own programs name the platform they belong to. */
      platform = cd[38];
    } else if (type == CSSLOT_ENTITLEMENTS) {
      unsigned char eh[8];
      if (read_at(fd, eh, sizeof eh, sig + offset) || be32(eh) != CSMAGIC_EMBEDDED_ENTITLEMENTS) continue;
      uint32_t len = be32(eh + 4);
      if (len <= 8 || len > (1u << 20)) continue;
      char *xml = malloc(len - 8);
      if (xml && !read_at(fd, xml, len - 8, sig + offset + 8)) {
        allow_dyld = entitled(xml, len - 8, "com.apple.security.cs.allow-dyld-environment-variables");
        disable_lv = entitled(xml, len - 8, "com.apple.security.cs.disable-library-validation");
      }
      free(xml);
    }
  }
  static const char *const system_dirs[] = {"/bin/", "/sbin/", "/usr/bin/", "/usr/sbin/", "/usr/libexec/",
                                            "/usr/lib/", "/System/"};
  for (size_t i = 0; i < sizeof system_dirs / sizeof *system_dirs; i++)
    if (strncmp(path, system_dirs[i], strlen(system_dirs[i])) == 0) p->protected = 1;
  if (platform || (flags & CS_RESTRICT)) p->protected = 1;
  /* The hardened runtime, and library validation, reject a library not signed by the same team. */
  if ((flags & CS_RUNTIME) && !(allow_dyld && disable_lv)) p->protected = 1;
  if ((flags & CS_REQUIRE_LV) && !disable_lv) p->protected = 1;
}

/* Which image of a universal file the kernel runs here, and whether it is arm64e. */
static void inspect_macho(int fd, const unsigned char *head, size_t n, const char *path, struct program *p) {
  uint32_t magic = be32(head);
  if (magic == FAT_MAGIC || magic == FAT_MAGIC_64) {
    int wide = magic == FAT_MAGIC_64;
    uint32_t count = be32(head + 4);
    off_t best = -1, arm64e = -1, arm64 = -1, x86 = -1;
    for (uint32_t i = 0; i < count && i < 32; i++) {
      unsigned char a[32];
      if (read_at(fd, a, wide ? 32 : 20, 8 + (off_t)i * (wide ? 32 : 20))) return;
      uint32_t type = be32(a), subtype = be32(a + 4) & 0xffffff;
      off_t offset = wide ? (off_t)be64(a + 8) : (off_t)be32(a + 8);
      if (type == CPU_TYPE_ARM64_ && subtype == CPU_SUBTYPE_ARM64E_) arm64e = offset;
      else if (type == CPU_TYPE_ARM64_) arm64 = offset;
      else if (type == CPU_TYPE_X86_64_) x86 = offset;
    }
    if (host_arm64) best = arm64e >= 0 ? arm64e : arm64 >= 0 ? arm64 : x86;
    else best = x86;
    if (best < 0) return;
    p->kind = PROGRAM_MACHO;
    p->arm64e = host_arm64 && best == arm64e && arm64 < 0;
    inspect_image(fd, best, path, p);
  } else if (n >= 12 && le32(head) == MH_MAGIC_64) {
    p->kind = PROGRAM_MACHO;
    p->arm64e = le32(head + 4) == CPU_TYPE_ARM64_ && (le32(head + 8) & 0xffffff) == CPU_SUBTYPE_ARM64E_;
    inspect_image(fd, 0, path, p);
  }
}

static void inspect(const char *path, struct program *p) {
  memset(p, 0, sizeof *p);
  p->kind = PROGRAM_MISSING;
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return;
  p->kind = PROGRAM_OTHER;
  unsigned char head[sizeof p->line];
  ssize_t n = fstat(fd, &p->st) == 0 ? pread(fd, head, sizeof head - 1, 0) : -1;
  if (n >= 2 && head[0] == '#' && head[1] == '!') {
    /* The kernel splits the rest of the first line at blanks into the interpreter and its arguments. */
    head[n] = '\0';
    char *end = memchr(head, '\n', (size_t)n);
    if (end) *end = '\0';
    memcpy(p->line, head + 2, sizeof p->line - 2);
    p->line[sizeof p->line - 1] = '\0';
    char *s = p->line;
    while (*s) {
      while (*s == ' ' || *s == '\t') *s++ = '\0';
      if (!*s) break;
      if (!p->interpreter) p->interpreter = s;
      else if (p->nargs < MAX_SCRIPT_ARGS) p->args[p->nargs++] = s;
      while (*s && *s != ' ' && *s != '\t') s++;
    }
    if (p->interpreter) p->kind = PROGRAM_SCRIPT;
  } else if (n >= 8) {
    inspect_macho(fd, head, (size_t)n, path, p);
    if (p->kind == PROGRAM_MACHO && (p->st.st_mode & (S_ISUID | S_ISGID))) p->untraceable = 1;
  }
  close(fd);
}

/* ---- shadow copies ------------------------------------------------------------------------------ */

/*
 * Runs a program with its standard streams on /dev/null and default signal handling; returns its
 * exit status, or -1. SIGCHLD stays blocked meanwhile, so a handler of the program's that reaps
 * any child (a shell's) cannot take this one's status.
 */
static int run_quietly(const char *program, char *const argv[], char *const envp[]) {
  posix_spawn_file_actions_t actions;
  posix_spawnattr_t attr;
  if (posix_spawn_file_actions_init(&actions) != 0) return -1;
  if (posix_spawnattr_init(&attr) != 0) {
    posix_spawn_file_actions_destroy(&actions);
    return -1;
  }
  for (int fd = 0; fd <= 2; fd++)
    posix_spawn_file_actions_addopen(&actions, fd, "/dev/null", fd ? O_WRONLY : O_RDONLY, 0);
  sigset_t none, all, saved;
  sigemptyset(&none);
  sigfillset(&all);
  posix_spawnattr_setsigmask(&attr, &none);
  posix_spawnattr_setsigdefault(&attr, &all);
  posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);
  sigset_t child;
  sigemptyset(&child);
  sigaddset(&child, SIGCHLD);
  pthread_sigmask(SIG_BLOCK, &child, &saved);
  pid_t pid;
  int status = -1;
  int r = posix_spawn(&pid, program, &actions, &attr, argv, envp);
  if (r == 0) {
    int ok;
    while ((ok = waitpid(pid, &status, 0)) < 0 && errno == EINTR) continue;
    if (ok < 0) status = -1;
  }
  pthread_sigmask(SIG_SETMASK, &saved, NULL);
  posix_spawn_file_actions_destroy(&actions);
  posix_spawnattr_destroy(&attr);
  if (r != 0 || status == -1) return -1;
  return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}

static int copy_file(const char *from, const char *to) {
  int in = open(from, O_RDONLY | O_CLOEXEC);
  if (in < 0) return -1;
  int out = open(to, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0700);
  if (out < 0) {
    close(in);
    return -1;
  }
  char buf[65536];
  ssize_t n;
  int ok = 1;
  while ((n = read(in, buf, sizeof buf)) != 0) {
    if (n < 0) {
      if (errno == EINTR) continue;
      ok = 0;
      break;
    }
    for (ssize_t done = 0; done < n;) {
      ssize_t w = write(out, buf + done, (size_t)(n - done));
      if (w < 0 && errno == EINTR) continue;
      if (w <= 0) {
        ok = 0;
        break;
      }
      done += w;
    }
    if (!ok) break;
  }
  close(in);
  if (close(out) != 0) ok = 0;
  return ok ? 0 : -1;
}

/*
 * The shadow copy of a protected program, made on first use: copied under a temporary name,
 * signed ad hoc, and renamed into place, so processes making the same copy never see half of one.
 */
static int shadow_of(const char *path, const struct stat *st, char *out) {
  if (!shadow_dir[0]) return -1;
  const char *base = strrchr(path, '/');
  base = base ? base + 1 : path;
  struct line dir = {.len = 0, .overflow = 0};
  put(&dir, shadow_dir);
  put_char(&dir, '/');
  put_number(&dir, (unsigned long long)st->st_dev, 16);
  put_char(&dir, '-');
  put_number(&dir, (unsigned long long)st->st_ino, 16);
  put_char(&dir, '-');
  put_number(&dir, (unsigned long long)st->st_mtimespec.tv_sec, 16);
  put_char(&dir, '.');
  put_number(&dir, (unsigned long long)st->st_mtimespec.tv_nsec, 16);
  put_char(&dir, '-');
  put_number(&dir, (unsigned long long)st->st_size, 16);
  struct line file = dir;
  put_char(&file, '/');
  put(&file, base);
  if (dir.overflow || file.overflow || file.len >= PATH_MAX) return -1;
  dir.buf[dir.len] = '\0';
  file.buf[file.len] = '\0';
  strcpy(out, file.buf);
  struct stat existing;
  if (stat(out, &existing) == 0 && S_ISREG(existing.st_mode)) return 0;
  mkdir(shadow_dir, 0700);
  mkdir(dir.buf, 0700);
  struct line temporary = dir;
  put(&temporary, "/.");
  put(&temporary, base);
  put_char(&temporary, '.');
  put_number(&temporary, (unsigned long long)getpid(), 10);
  if (temporary.overflow) return -1;
  temporary.buf[temporary.len] = '\0';
  unlink(temporary.buf);
  char *const argv[] = {"codesign", "--force", "--sign", "-", temporary.buf, NULL};
  char *const envp[] = {"PATH=/usr/bin:/bin", NULL};
  if (copy_file(path, temporary.buf) == 0 && run_quietly("/usr/bin/codesign", argv, envp) == 0 &&
      rename(temporary.buf, out) == 0)
    return 0;
  unlink(temporary.buf);
  return -1;
}

/*
 * Whether an ad hoc arm64e program runs here with this library loaded. Machines with System
 * Integrity Protection on may refuse arm64e programs Apple did not sign. Checked once per run.
 */
static int arm64e_shadows_run(void) {
  static int known; /* 1 yes, -1 no */
  if (known) return known > 0;
  char yes[PATH_MAX], no[PATH_MAX];
  struct line y = {.len = 0, .overflow = 0}, n = {.len = 0, .overflow = 0};
  put(&y, shadow_dir);
  put(&y, "/arm64e-runs");
  put(&n, shadow_dir);
  put(&n, "/arm64e-fails");
  if (y.overflow || n.overflow) return 0;
  memcpy(yes, y.buf, y.len);
  yes[y.len] = '\0';
  memcpy(no, n.buf, n.len);
  no[n.len] = '\0';
  struct stat st;
  if (stat(yes, &st) == 0) known = 1;
  else if (stat(no, &st) == 0) known = -1;
  if (known) return known > 0;
  char shadow[PATH_MAX];
  known = -1;
  struct stat t;
  if (stat("/usr/bin/true", &t) == 0 && shadow_of("/usr/bin/true", &t, shadow) == 0) {
    char insert[PATH_MAX + 32] = "DYLD_INSERT_LIBRARIES=";
    strlcat(insert, own_path, sizeof insert);
    char *const argv[] = {"true", NULL};
    char *const envp[] = {insert, NULL};
    if (run_quietly(shadow, argv, envp) == 0) known = 1;
  }
  int fd = open(known > 0 ? yes : no, O_WRONLY | O_CREAT | O_CLOEXEC, 0600);
  if (fd >= 0) close(fd);
  return known > 0;
}

/* ---- exec --------------------------------------------------------------------------------------- */

/* veyrum-exec, next to this library: Veyrum's own launcher (a nested capture's) is not an input. */
static int is_launcher(const char *path) {
  char launcher[PATH_MAX];
  const char *slash = strrchr(own_path, '/');
  if (!slash || (size_t)(slash - own_path) + sizeof "/veyrum-exec" > sizeof launcher) return 0;
  memcpy(launcher, own_path, (size_t)(slash - own_path));
  strcpy(launcher + (slash - own_path), "/veyrum-exec");
  struct stat a, b;
  return stat(path, &a) == 0 && stat(launcher, &b) == 0 && a.st_dev == b.st_dev && a.st_ino == b.st_ino;
}

/* How an exec runs under tracing. */
struct plan {
  enum { RUN_TRACED, RUN_UNTRACED } how;
  /* The file executed: the program, or a shadow copy of it (or of a script's interpreter). */
  char file[PATH_MAX];
  /* A script whose interpreter runs as a shadow copy: the arguments the kernel would have given it. */
  struct program script;
  int via_interpreter;
};

/* Makes `p`'s shadow copy into `out`; false when the program cannot be traced. */
static int traceable(const char *path, const struct program *p, char *out) {
  if (p->untraceable) return 0;
  if (!p->protected) {
    strlcpy(out, path, PATH_MAX);
    return 1;
  }
  /*
   * A copy of an application's executable, or of a program that loads its libraries relative to
   * itself, would not run as the original does.
   */
  if (p->located || strstr(path, ".app/Contents/MacOS/")) return 0;
  if (p->arm64e && !arm64e_shadows_run()) return 0;
  return shadow_of(path, &p->st, out) == 0;
}

/*
 * Records an exec of `path` and decides how it runs: traced as itself, as a shadow copy, or
 * untraced (recorded as untraceable). A program that does not exist, or that the kernel will not
 * run, is recorded as read: the exec fails, and PATH lookups record their absent candidates so.
 */
static void plan_exec(const char *path, struct plan *plan) {
  plan->how = RUN_TRACED;
  plan->via_interpreter = 0;
  strlcpy(plan->file, path, sizeof plan->file);
  if (!tracing() || is_launcher(path)) return;
  struct program p;
  inspect(path, &p);
  if (p.kind == PROGRAM_MACHO) {
    if (traceable(path, &p, plan->file)) {
      emit('x', path);
    } else {
      emit('u', path);
      plan->how = RUN_UNTRACED;
      strlcpy(plan->file, path, sizeof plan->file);
    }
  } else if (p.kind == PROGRAM_SCRIPT) {
    emit('x', path);
    struct program interpreter;
    inspect(p.interpreter, &interpreter);
    if (interpreter.kind != PROGRAM_MACHO) {
      /* Nothing runs, or the kernel refuses an interpreter that is itself a script. */
      emit('x', p.interpreter);
    } else if (!traceable(p.interpreter, &interpreter, plan->file)) {
      emit('u', p.interpreter);
      plan->how = RUN_UNTRACED;
      strlcpy(plan->file, path, sizeof plan->file);
    } else {
      emit('x', p.interpreter);
      if (interpreter.protected) {
        /* The words point into the line: point the copy's into its own line. */
        plan->script = p;
        plan->script.interpreter = plan->script.line + (p.interpreter - p.line);
        for (int i = 0; i < p.nargs; i++) plan->script.args[i] = plan->script.line + (p.args[i] - p.line);
        plan->via_interpreter = 1;
      } else {
        strlcpy(plan->file, path, sizeof plan->file);
      }
    }
  } else {
    emit('x', path);
  }
}

static size_t count(char *const list[]) {
  size_t n = 0;
  while (list && list[n]) n++;
  return n;
}

/*
 * The arguments an exec passes: the program's own, or for a script run through its interpreter's
 * shadow copy, the interpreter, its arguments and the script's path first (as the kernel does).
 * `out` has room for the given arguments plus MAX_SCRIPT_ARGS + 3.
 */
static char *const *exec_argv(const struct plan *plan, const char *path, char *const argv[], char **out) {
  if (!plan->via_interpreter) return argv;
  size_t n = 0;
  out[n++] = plan->script.interpreter;
  for (int i = 0; i < plan->script.nargs; i++) out[n++] = plan->script.args[i];
  out[n++] = (char *)path;
  for (size_t i = 1; argv && argv[0] && argv[i]; i++) out[n++] = argv[i];
  out[n] = NULL;
  return out;
}

/* Whether a colon-separated DYLD_INSERT_LIBRARIES value lists this library. */
static int lists_library(const char *value) {
  size_t len = strlen(own_path);
  for (const char *p = value; (p = strstr(p, own_path)) != NULL; p += len)
    if ((p == value || p[-1] == ':') && (p[len] == '\0' || p[len] == ':')) return 1;
  return 0;
}

/*
 * The environment for an exec: a traced program gets DYLD_INSERT_LIBRARIES and VEYRUM_TRACE back
 * if it removed them (a VEYRUM_TRACE that is present is kept: a nested capture points its children
 * at another log); an untraced one loses this library, which could only stop it from starting.
 * `out` has room for the given entries plus two; `entry` for the insert list plus this library.
 */
static char *const *exec_env(char *const envp[], int traced, char **out, char *entry, size_t cap) {
  const char *insert = NULL;
  int has_trace = 0;
  size_t n = 0;
  for (char *const *e = envp; e && *e; e++) {
    if (strncmp(*e, "DYLD_INSERT_LIBRARIES=", 22) == 0) {
      insert = *e + 22;
      continue;
    }
    if (strncmp(*e, "VEYRUM_TRACE=", 13) == 0 && (*e)[13]) has_trace = 1;
    out[n++] = *e;
  }
  strlcpy(entry, "DYLD_INSERT_LIBRARIES=", cap);
  if (traced) {
    if (insert && lists_library(insert)) {
      strlcat(entry, insert, cap);
    } else {
      strlcat(entry, own_path, cap);
      if (insert && *insert) {
        strlcat(entry, ":", cap);
        strlcat(entry, insert, cap);
      }
    }
    out[n++] = entry;
    if (!has_trace) out[n++] = trace_entry;
  } else if (insert) {
    /* The other libraries listed, in order. */
    size_t len = strlen(own_path), start = strlen(entry);
    for (const char *p = insert; *p;) {
      const char *colon = strchr(p, ':');
      size_t item = colon ? (size_t)(colon - p) : strlen(p);
      if (item && !(item == len && strncmp(p, own_path, len) == 0) && strlen(entry) + item + 2 < cap) {
        if (strlen(entry) > start) strlcat(entry, ":", cap);
        strncat(entry, p, item);
      }
      p += item + (colon ? 1 : 0);
    }
    if (strlen(entry) > start) out[n++] = entry;
  }
  out[n] = NULL;
  return out;
}

#define EXEC_BUFFERS(argv, envp)                                     \
  char *args_buf[count(argv) + MAX_SCRIPT_ARGS + 4];                \
  char *env_buf[count(envp) + 3];                                   \
  const char *insert_now = env_lookup(envp, "DYLD_INSERT_LIBRARIES"); \
  size_t entry_cap = (insert_now ? strlen(insert_now) : 0) + strlen(own_path) + 32; \
  char entry_buf[entry_cap]

static int v_execve(const char *path, char *const argv[], char *const envp[]) {
  if (!tracing()) return execve(path, argv, envp);
  struct plan plan;
  plan_exec(path, &plan);
  EXEC_BUFFERS(argv, envp);
  return execve(plan.file, exec_argv(&plan, path, argv, args_buf),
                exec_env(envp, plan.how == RUN_TRACED, env_buf, entry_buf, entry_cap));
}
INTERPOSE(v_execve, execve);

static int spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *actions,
                 const posix_spawnattr_t *attr, char *const argv[], char *const envp[]) {
  struct plan plan;
  plan_exec(path, &plan);
  EXEC_BUFFERS(argv, envp);
  return posix_spawn(pid, plan.file, actions, attr, exec_argv(&plan, path, argv, args_buf),
                     exec_env(envp, plan.how == RUN_TRACED, env_buf, entry_buf, entry_cap));
}

static int v_posix_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *actions,
                         const posix_spawnattr_t *attr, char *const argv[], char *const envp[]) {
  if (!tracing()) return posix_spawn(pid, path, actions, attr, argv, envp);
  return spawn(pid, path, actions, attr, argv, envp);
}
INTERPOSE(v_posix_spawn, posix_spawn);

/*
 * posix_spawnp looks the file up on this process's PATH. It is looked up here, recording the
 * candidates tried before the match, and spawned like posix_spawn; a file that is not a program the
 * kernel runs (a script without #!) is left to posix_spawnp, which runs it with /bin/sh.
 */
static int v_posix_spawnp(pid_t *pid, const char *file, const posix_spawn_file_actions_t *actions,
                          const posix_spawnattr_t *attr, char *const argv[], char *const envp[]) {
  if (!tracing() || !file || strchr(file, '/')) {
    if (!tracing()) return posix_spawnp(pid, file, actions, attr, argv, envp);
    return spawn(pid, file, actions, attr, argv, envp);
  }
  const char *dirs = getenv("PATH");
  if (!dirs) dirs = "/usr/bin:/bin";
  char candidate[PATH_MAX];
  while (1) {
    const char *colon = strchr(dirs, ':');
    size_t len = colon ? (size_t)(colon - dirs) : strlen(dirs);
    if (len + strlen(file) + 2 < sizeof candidate) {
      if (len == 0) {
        strcpy(candidate, file);
      } else {
        memcpy(candidate, dirs, len);
        candidate[len] = '/';
        strcpy(candidate + len + 1, file);
      }
      struct stat st;
      if (stat(candidate, &st) == 0 && S_ISREG(st.st_mode) && access(candidate, X_OK) == 0) {
        int r = spawn(pid, candidate, actions, attr, argv, envp);
        if (r != ENOEXEC) return r;
        break;
      }
      emit(stat(candidate, &st) == 0 ? 's' : 'S', candidate);
    }
    if (!colon) break;
    dirs = colon + 1;
  }
  EXEC_BUFFERS(argv, envp);
  (void)args_buf;
  return posix_spawnp(pid, file, actions, attr, argv, exec_env(envp, 1, env_buf, entry_buf, entry_cap));
}
INTERPOSE(v_posix_spawnp, posix_spawnp);

/* A file the kernel opens for the spawned process. */
static int v_posix_spawn_file_actions_addopen(posix_spawn_file_actions_t *actions, int fd, const char *path,
                                              int flags, mode_t mode) {
  int r = posix_spawn_file_actions_addopen(actions, fd, path, flags, mode);
  if (r == 0 && tracing()) {
    if ((flags & O_ACCMODE) != O_WRONLY) emit('r', path);
    if (wants_write(flags)) emit('w', path);
  }
  return r;
}
INTERPOSE(v_posix_spawn_file_actions_addopen, posix_spawn_file_actions_addopen);

/* ---- start -------------------------------------------------------------------------------------- */

/* Tells a launcher that the tracer is loaded (see launch-darwin.c). */
__attribute__((visibility("default"))) int veyrum_trace_loaded = 1;

__attribute__((constructor)) static void veyrum_trace_init(void) {
  init();
  if (log_fd < 0) return;
  dlopen_from_fn = (void *(*)(const char *, int, void *))dlsym(RTLD_DEFAULT, "dlopen_from");
  _dyld_register_func_for_add_image(image_added);
}
