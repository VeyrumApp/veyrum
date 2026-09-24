/*
 * veyrum-exec: runs a program the preloaded tracer (trace.c) cannot follow, a statically linked or
 * Go program that makes system calls itself, under a ptrace tracer that writes the same events to
 * the same log (VEYRUM_TRACE; the format is described in trace.c).
 *
 *   veyrum-exec <program> [argv0 [args...]]
 *
 * The program replaces this process, so its pid, parent, standard streams, signals and exit status
 * are the ones the caller expects. The tracer is a grandchild in a session of its own: the program
 * never sees it as a child, and it holds none of the program's streams open. It attaches with
 * PTRACE_SEIZE (which PR_SET_PTRACER allows under Yama) before the exec. A seccomp filter stops the
 * program only at the system calls that matter (file access, exec, connect); everything else runs
 * at full speed. The tracer follows every thread and process the program starts, and outlives them
 * by nothing: it exits once the last one has.
 *
 * Events are written before the stopped thread continues, so they are in the log before the
 * program's exit can be seen by its parent.
 *
 * When tracing cannot start (ptrace forbidden, no seccomp, a debugger already attached), the
 * program runs untraced and the log records it as untraceable ("u"), which ends reuse. Tracing sets
 * no_new_privs: a set-user-ID program started this way does not gain privileges.
 *
 * Built statically, so the preloaded library never runs in the launcher itself.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <netinet/in.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

#if defined(__x86_64__)
#define NATIVE_ARCH AUDIT_ARCH_X86_64
/* x32 system calls carry this bit; their numbers mean something else. */
#define X32_BIT 0x40000000
#elif defined(__aarch64__)
#define NATIVE_ARCH AUDIT_ARCH_AARCH64
#else
#error "veyrum-exec supports x86-64 and arm64"
#endif

/* PTRACE_GET_SYSCALL_INFO (Linux 5.3), declared here: C library headers differ in whether they have it. */
#define GET_SYSCALL_INFO 0x420e
#define INFO_EXIT 2
#define INFO_SECCOMP 3
struct syscall_info {
  uint8_t op;
  uint8_t pad[3];
  uint32_t arch;
  uint64_t instruction_pointer;
  uint64_t stack_pointer;
  union {
    struct {
      int64_t rval;
      uint8_t is_error;
    } exit;
    struct {
      uint64_t nr;
      uint64_t args[6];
      uint32_t ret_data;
    } seccomp;
  };
};

/* ---- the system calls that stop --------------------------------------------------------------- */

enum op {
  OP_NONE,
  OP_OPEN,       /* open(path, flags) */
  OP_OPENAT,     /* openat(dirfd, path, flags) */
  OP_OPENAT2,    /* openat2(dirfd, path, how) */
  OP_CREAT,      /* creat(path) */
  OP_STAT,       /* stat(path), lstat(path) */
  OP_STATAT,     /* newfstatat(dirfd, path, buf, flags) */
  OP_STATX,      /* statx(dirfd, path, flags) */
  OP_ACCESS,     /* access(path) */
  OP_ACCESSAT,   /* faccessat(dirfd, path), faccessat2 */
  OP_READLINK,   /* readlink(path) */
  OP_READLINKAT, /* readlinkat(dirfd, path) */
  OP_GETDENTS,   /* getdents64(fd) */
  OP_EXECVE,     /* execve(path) */
  OP_EXECVEAT,   /* execveat(dirfd, path, argv, envp, flags) */
  OP_CONNECT,    /* connect(fd, addr, len) */
  OP_WRITE,      /* unlink(path), rmdir, mkdir, truncate, mknod */
  OP_WRITEAT,    /* unlinkat(dirfd, path), mkdirat, mknodat */
  OP_RENAME,     /* rename(from, to) */
  OP_RENAMEAT,   /* renameat(fromfd, from, tofd, to), renameat2 */
  OP_LINK,       /* link(from, to) */
  OP_LINKAT,     /* linkat(fromfd, from, tofd, to, flags) */
  OP_SYMLINK,    /* symlink(target, path) */
  OP_SYMLINKAT,  /* symlinkat(target, dirfd, path) */
  OP_OPAQUE,     /* reaches files without a path this tracer can follow */
};

static const struct {
  long nr;
  enum op op;
  const char *name;
} traced[] = {
#ifdef __NR_open
    {__NR_open, OP_OPEN, "open"},
#endif
    {__NR_openat, OP_OPENAT, "openat"},
#ifdef __NR_openat2
    {__NR_openat2, OP_OPENAT2, "openat2"},
#endif
#ifdef __NR_creat
    {__NR_creat, OP_CREAT, "creat"},
#endif
#ifdef __NR_stat
    {__NR_stat, OP_STAT, "stat"},
    {__NR_lstat, OP_STAT, "lstat"},
#endif
    {__NR_newfstatat, OP_STATAT, "newfstatat"},
    {__NR_statx, OP_STATX, "statx"},
#ifdef __NR_access
    {__NR_access, OP_ACCESS, "access"},
#endif
    {__NR_faccessat, OP_ACCESSAT, "faccessat"},
#ifdef __NR_faccessat2
    {__NR_faccessat2, OP_ACCESSAT, "faccessat2"},
#endif
#ifdef __NR_readlink
    {__NR_readlink, OP_READLINK, "readlink"},
#endif
    {__NR_readlinkat, OP_READLINKAT, "readlinkat"},
#ifdef __NR_getdents
    {__NR_getdents, OP_GETDENTS, "getdents"},
#endif
    {__NR_getdents64, OP_GETDENTS, "getdents64"},
    {__NR_execve, OP_EXECVE, "execve"},
    {__NR_execveat, OP_EXECVEAT, "execveat"},
    {__NR_connect, OP_CONNECT, "connect"},
#ifdef __NR_unlink
    {__NR_unlink, OP_WRITE, "unlink"},
    {__NR_rmdir, OP_WRITE, "rmdir"},
    {__NR_mkdir, OP_WRITE, "mkdir"},
    {__NR_mknod, OP_WRITE, "mknod"},
#endif
    {__NR_truncate, OP_WRITE, "truncate"},
    {__NR_unlinkat, OP_WRITEAT, "unlinkat"},
    {__NR_mkdirat, OP_WRITEAT, "mkdirat"},
    {__NR_mknodat, OP_WRITEAT, "mknodat"},
#ifdef __NR_rename
    {__NR_rename, OP_RENAME, "rename"},
#endif
#ifdef __NR_renameat
    {__NR_renameat, OP_RENAMEAT, "renameat"},
#endif
    {__NR_renameat2, OP_RENAMEAT, "renameat2"},
#ifdef __NR_link
    {__NR_link, OP_LINK, "link"},
    {__NR_symlink, OP_SYMLINK, "symlink"},
#endif
    {__NR_linkat, OP_LINKAT, "linkat"},
    {__NR_symlinkat, OP_SYMLINKAT, "symlinkat"},
    {__NR_io_uring_setup, OP_OPAQUE, "io_uring_setup"},
    {__NR_open_by_handle_at, OP_OPAQUE, "open_by_handle_at"},
};
#define TRACED_COUNT (sizeof traced / sizeof *traced)

static const char *op_name;
static enum op op_of(long nr) {
  for (size_t i = 0; i < TRACED_COUNT; i++)
    if (traced[i].nr == nr) {
      op_name = traced[i].name;
      return traced[i].op;
    }
  return OP_NONE;
}

/* ---- logs ---------------------------------------------------------------------------------- */

/*
 * The logs events go to. A process that starts its own capture (Veyrum testing itself) points its
 * children at another log, as with the preloaded tracer: the launcher it runs under this tracer
 * switches its process tree to that log.
 */
#define MAX_LOGS 16
static struct {
  char path[PATH_MAX];
  int fd;
} logs[MAX_LOGS];
static int log_count;

static int log_index(const char *path) {
  for (int i = 0; i < log_count; i++)
    if (strcmp(logs[i].path, path) == 0) return i;
  if (log_count == MAX_LOGS || strlen(path) >= PATH_MAX) return 0;
  strcpy(logs[log_count].path, path);
  logs[log_count].fd = -1;
  return log_count++;
}

static void log_write(int index, const char *buf, size_t len) {
  if (logs[index].fd < 0) {
    logs[index].fd = open(logs[index].path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0600);
    if (logs[index].fd < 0) return;
  }
  while (len > 0) {
    ssize_t n = write(logs[index].fd, buf, len);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return;
    buf += n;
    len -= (size_t)n;
  }
}

/* ---- tasks --------------------------------------------------------------------------------- */

#define LINE_CAP (PATH_MAX * 2 + 8)

struct task {
  pid_t tid;
  int log;
  /* Running the launcher (a nested capture's): its own system calls are Veyrum's, not the program's. */
  int launcher;
  int compat_reported;
  /* The system call waiting for its exit stop, with what its entry recorded. */
  enum op pending;
  int flags;
  int unresolved;
  char path[LINE_CAP];
  /* Hash of the last line written for this task: repeated lines (a directory read in chunks) are dropped. */
  uint64_t last;
};

/* Open addressing on the thread id; deleted slots keep a tombstone. */
#define TOMBSTONE ((struct task *)1)
static struct task **table;
static size_t table_cap, table_used;

static size_t slot_of(pid_t tid) { return ((size_t)tid * 2654435761u) & (table_cap - 1); }

static struct task *task_find(pid_t tid) {
  if (!table_cap) return NULL;
  for (size_t i = slot_of(tid);; i = (i + 1) & (table_cap - 1)) {
    struct task *t = table[i];
    if (!t) return NULL;
    if (t != TOMBSTONE && t->tid == tid) return t;
  }
}

static void table_insert(struct task *t) {
  size_t i = slot_of(t->tid);
  while (table[i] && table[i] != TOMBSTONE) i = (i + 1) & (table_cap - 1);
  table[i] = t;
}

static void table_grow(void) {
  size_t old_cap = table_cap;
  struct task **old = table;
  table_cap = old_cap ? old_cap * 2 : 64;
  table = calloc(table_cap, sizeof *table);
  if (!table) _exit(1);
  table_used = 0;
  for (size_t i = 0; i < old_cap; i++)
    if (old[i] && old[i] != TOMBSTONE) {
      table_insert(old[i]);
      table_used++;
    }
  free(old);
}

static void task_remove(pid_t tid) {
  if (!table_cap) return;
  for (size_t i = slot_of(tid);; i = (i + 1) & (table_cap - 1)) {
    struct task *t = table[i];
    if (!t) return;
    if (t != TOMBSTONE && t->tid == tid) {
      free(t);
      table[i] = TOMBSTONE;
      return;
    }
  }
}

static struct task *task_add(pid_t tid, int log) {
  /* Tombstones count as used until the next growth clears them. */
  if ((table_used + 1) * 2 > table_cap) table_grow();
  struct task *t = calloc(1, sizeof *t);
  if (!t) _exit(1);
  t->tid = tid;
  t->log = log;
  table_insert(t);
  table_used++;
  return t;
}

/* A field of /proc/<tid>/status, or 0. */
static pid_t status_field(pid_t tid, const char *field) {
  char name[64], buf[2048];
  snprintf(name, sizeof name, "/proc/%d/status", tid);
  int fd = open(name, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return 0;
  ssize_t n = read(fd, buf, sizeof buf - 1);
  close(fd);
  if (n <= 0) return 0;
  buf[n] = '\0';
  size_t len = strlen(field);
  for (char *line = buf; line && *line; line = strchr(line, '\n') ? strchr(line, '\n') + 1 : NULL)
    if (strncmp(line, field, len) == 0 && line[len] == ':') return (pid_t)atoi(line + len + 1);
  return 0;
}

/*
 * The task for a thread id. A new thread or child can stop before its creator reports it: it then
 * takes the log of its thread group, or of its parent.
 */
static struct task *task_get(pid_t tid) {
  struct task *t = task_find(tid);
  if (t) return t;
  struct task *related = task_find(status_field(tid, "Tgid"));
  if (!related) related = task_find(status_field(tid, "PPid"));
  t = task_add(tid, related ? related->log : 0);
  if (related) t->launcher = related->launcher;
  return t;
}

/* ---- reading the tracee -------------------------------------------------------------------- */

/* A NUL-terminated string from the tracee: its length, -1 when unreadable, -2 when too long. */
static int read_string(pid_t tid, uint64_t addr, char *out, size_t cap) {
  if (!addr) return -1;
  size_t at = 0;
  while (at < cap) {
    /* Never read across a page boundary in one go: the next page may be unmapped. */
    size_t page = 4096 - ((addr + at) & 4095);
    size_t want = cap - at < page ? cap - at : page;
    struct iovec local = {out + at, want};
    struct iovec remote = {(void *)(uintptr_t)(addr + at), want};
    ssize_t n = process_vm_readv(tid, &local, 1, &remote, 1, 0);
    if (n <= 0) return -1;
    char *nul = memchr(out + at, 0, (size_t)n);
    if (nul) return (int)(nul - out);
    at += (size_t)n;
  }
  return -2;
}

static int read_bytes(pid_t tid, uint64_t addr, void *out, size_t len) {
  struct iovec local = {out, len};
  struct iovec remote = {(void *)(uintptr_t)addr, len};
  return process_vm_readv(tid, &local, 1, &remote, 1, 0) == (ssize_t)len ? 0 : -1;
}

/* The target of a /proc/<tid>/... link. */
static int proc_link(pid_t tid, const char *what, char *out, size_t cap) {
  char name[64];
  snprintf(name, sizeof name, "/proc/%d/%s", tid, what);
  ssize_t n = readlink(name, out, cap - 1);
  if (n <= 0) return -1;
  out[n] = '\0';
  return 0;
}

/* Directory a relative path is resolved against: the working directory, or the dirfd's. */
static int base_dir(pid_t tid, int dirfd, char *out, size_t cap) {
  if (dirfd == AT_FDCWD) return proc_link(tid, "cwd", out, cap);
  char what[32];
  snprintf(what, sizeof what, "fd/%d", dirfd);
  return proc_link(tid, what, out, cap);
}

/*
 * The absolute path of a system call's path argument, as trace.c writes it: relative paths are
 * joined to their base directory, normalization is left to the reader. 1 when there is no path
 * (a null or empty argument), -1 when it cannot be recorded faithfully.
 */
static int resolve(pid_t tid, int dirfd, uint64_t addr, char *out, size_t cap) {
  char path[PATH_MAX];
  int n = read_string(tid, addr, path, sizeof path);
  if (n == -1) return 1; /* The call fails with EFAULT: nothing is accessed. */
  if (n == 0) return 1;
  if (n < 0 || strchr(path, '\n')) return -1;
  size_t at = 0;
  if (path[0] != '/') {
    if (base_dir(tid, dirfd, out, cap) != 0) return -1;
    at = strlen(out);
    if (at + 1 >= cap) return -1;
    out[at++] = '/';
  }
  if (at + (size_t)n + 1 > cap) return -1;
  memcpy(out + at, path, (size_t)n + 1);
  return 0;
}

/* The path an open descriptor refers to. */
static int fd_path(pid_t tid, int fd, char *out, size_t cap) {
  char what[32];
  snprintf(what, sizeof what, "fd/%d", fd);
  if (proc_link(tid, what, out, cap) != 0 || out[0] != '/' || strchr(out, '\n')) return -1;
  return 0;
}

/* ---- writing events ------------------------------------------------------------------------ */

static void write_line(struct task *t, const char *line, size_t len) {
  uint64_t h = 1469598103934665603u;
  for (size_t i = 0; i < len; i++) h = (h ^ (unsigned char)line[i]) * 1099511628211u;
  if (h == t->last) return;
  t->last = h;
  log_write(t->log, line, len);
}

static void emit_untraceable(struct task *t, const char *what) {
  char line[128];
  int n = snprintf(line, sizeof line, "u %s\n", what);
  if (n > 0 && (size_t)n < sizeof line) write_line(t, line, (size_t)n);
}

static void emit(struct task *t, char kind, const char *path) {
  if (t->launcher) return;
  char line[LINE_CAP + 4];
  size_t len = strlen(path);
  if (len + 3 > sizeof line) {
    emit_untraceable(t, "unrecordable path");
    return;
  }
  line[0] = kind;
  line[1] = ' ';
  memcpy(line + 2, path, len);
  line[len + 2] = '\n';
  write_line(t, line, len + 3);
}

/* Records a path argument now: for calls whose result does not change the event. */
static void emit_arg(struct task *t, char kind, int dirfd, uint64_t addr) {
  char path[LINE_CAP];
  int r = resolve(t->tid, dirfd, addr, path, sizeof path);
  if (r == 0) emit(t, kind, path);
  else if (r < 0 && !t->launcher) emit_untraceable(t, "unrecordable path");
}

/* Keeps a path argument for the exit stop, which decides the event. Returns whether one is kept. */
static int keep_arg(struct task *t, enum op op, int flags, int dirfd, uint64_t addr) {
  int r = resolve(t->tid, dirfd, addr, t->path, sizeof t->path);
  if (r > 0) return 0;
  t->pending = op;
  t->flags = flags;
  t->unresolved = r < 0;
  return 1;
}

static int wants_write(int flags) { return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) != 0; }

/* ---- stops --------------------------------------------------------------------------------- */

static dev_t own_dev;
static ino_t own_ino;

static int is_launcher(const char *path) {
  struct stat st;
  return stat(path, &st) == 0 && st.st_dev == own_dev && st.st_ino == own_ino;
}

/* A system call entry the filter stopped. Returns whether its exit stop is needed. */
static int on_entry(struct task *t, const struct syscall_info *si) {
  if (si->arch != NATIVE_ARCH
#ifdef X32_BIT
      || (si->seccomp.nr & X32_BIT)
#endif
  ) {
    if (!t->compat_reported) emit_untraceable(t, "system call of another architecture");
    t->compat_reported = 1;
    return 0;
  }
  const uint64_t *a = si->seccomp.args;
  enum op op = op_of((long)si->seccomp.nr);
  switch (op) {
    case OP_OPEN:
      return keep_arg(t, op, (int)a[1], AT_FDCWD, a[0]);
    case OP_OPENAT:
      return keep_arg(t, op, (int)a[2], (int)a[0], a[1]);
    case OP_OPENAT2: {
      struct {
        uint64_t flags, mode, resolve;
      } how;
      if (a[3] < sizeof how || read_bytes(t->tid, a[2], &how, sizeof how) != 0) return 0;
      /* RESOLVE_IN_ROOT reads the path relative to the dirfd as the root directory. */
      if (how.resolve & 0x10) {
        if (!t->launcher) emit_untraceable(t, "openat2");
        return 0;
      }
      return keep_arg(t, op, (int)how.flags, (int)a[0], a[1]);
    }
    case OP_CREAT:
      return keep_arg(t, op, O_CREAT | O_WRONLY | O_TRUNC, AT_FDCWD, a[0]);
    case OP_STAT:
    case OP_ACCESS:
    case OP_READLINK:
      return keep_arg(t, op, 0, AT_FDCWD, a[0]);
    case OP_STATAT:
    case OP_STATX: {
      int flags = (int)(op == OP_STATAT ? a[3] : a[2]);
      char probe[2];
      /* An empty path with AT_EMPTY_PATH is fstat on the descriptor: no path is involved. */
      if ((flags & AT_EMPTY_PATH) && read_string(t->tid, a[1], probe, sizeof probe) == 0) return 0;
      return keep_arg(t, op, 0, (int)a[0], a[1]);
    }
    case OP_ACCESSAT:
    case OP_READLINKAT:
      return keep_arg(t, op, 0, (int)a[0], a[1]);
    case OP_GETDENTS:
      if (fd_path(t->tid, (int)a[0], t->path, sizeof t->path) != 0) {
        /* Not a path (a descriptor of another kind): the call fails or lists nothing on disk. */
        return 0;
      }
      t->pending = op;
      t->unresolved = 0;
      return 1;
    case OP_EXECVE:
    case OP_EXECVEAT: {
      char path[LINE_CAP];
      int r;
      if (op == OP_EXECVEAT && (a[4] & AT_EMPTY_PATH)) {
        char probe[2];
        r = read_string(t->tid, a[1], probe, sizeof probe) == 0 ? fd_path(t->tid, (int)a[0], path, sizeof path) : 1;
        if (r == 1) r = resolve(t->tid, (int)a[0], a[1], path, sizeof path);
      } else {
        r = resolve(t->tid, op == OP_EXECVEAT ? (int)a[0] : AT_FDCWD, op == OP_EXECVEAT ? a[1] : a[0], path,
                    sizeof path);
      }
      /* The launcher itself is Veyrum, not an input. */
      if (r == 0 && !is_launcher(path)) {
        int launcher = t->launcher;
        t->launcher = 0;
        emit(t, 'x', path);
        t->launcher = launcher;
      } else if (r < 0) {
        emit_untraceable(t, "unrecordable path");
      }
      return 0;
    }
    case OP_CONNECT: {
      if (t->launcher) return 0;
      union {
        struct sockaddr sa;
        struct sockaddr_in in;
        struct sockaddr_in6 in6;
        struct sockaddr_un un;
      } addr;
      memset(&addr, 0, sizeof addr);
      size_t len = a[2] < sizeof addr ? (size_t)a[2] : sizeof addr;
      if (len < sizeof(sa_family_t) || read_bytes(t->tid, a[1], &addr, len) != 0) return 0;
      char host[INET6_ADDRSTRLEN];
      int n = -1;
      if (addr.sa.sa_family == AF_INET && len >= sizeof addr.in) {
        inet_ntop(AF_INET, &addr.in.sin_addr, host, sizeof host);
        n = snprintf(t->path, sizeof t->path, "n %s %u\n", host, ntohs(addr.in.sin_port));
      } else if (addr.sa.sa_family == AF_INET6 && len >= sizeof addr.in6) {
        inet_ntop(AF_INET6, &addr.in6.sin6_addr, host, sizeof host);
        n = snprintf(t->path, sizeof t->path, "n %s %u\n", host, ntohs(addr.in6.sin6_port));
      } else if (addr.sa.sa_family == AF_UNIX) {
        /* Treated like the test's own Unix socket connections: local. */
        const char *p = addr.un.sun_path;
        n = snprintf(t->path, sizeof t->path, "n unix:%.*s 0\n", (int)sizeof addr.un.sun_path, p[0] ? p : "abstract");
      }
      if (n <= 0 || (size_t)n >= sizeof t->path) return 0;
      t->pending = op;
      t->unresolved = 0;
      return 1;
    }
    case OP_WRITE:
      emit_arg(t, 'w', AT_FDCWD, a[0]);
      return 0;
    case OP_WRITEAT:
      emit_arg(t, 'w', (int)a[0], a[1]);
      return 0;
    case OP_RENAME:
      emit_arg(t, 'w', AT_FDCWD, a[0]);
      emit_arg(t, 'w', AT_FDCWD, a[1]);
      return 0;
    case OP_RENAMEAT:
      emit_arg(t, 'w', (int)a[0], a[1]);
      emit_arg(t, 'w', (int)a[2], a[3]);
      return 0;
    case OP_LINK:
      emit_arg(t, 'r', AT_FDCWD, a[0]);
      emit_arg(t, 'w', AT_FDCWD, a[1]);
      return 0;
    case OP_LINKAT:
      emit_arg(t, 'r', (int)a[0], a[1]);
      emit_arg(t, 'w', (int)a[2], a[3]);
      return 0;
    case OP_SYMLINK:
      emit_arg(t, 'w', AT_FDCWD, a[1]);
      return 0;
    case OP_SYMLINKAT:
      emit_arg(t, 'w', (int)a[1], a[2]);
      return 0;
    case OP_OPAQUE:
      if (!t->launcher) emit_untraceable(t, op_name);
      return 0;
    case OP_NONE:
      return 0;
  }
  return 0;
}

/* Kernel-internal codes of a system call that is restarted: it stops at its entry again. */
static int restarting(long err) { return err >= 512 && err <= 516; }

static void on_exit_stop(struct task *t, const struct syscall_info *si) {
  enum op op = t->pending;
  t->pending = OP_NONE;
  if (op == OP_NONE || si->op != INFO_EXIT) return;
  int ok = !si->exit.is_error;
  long err = ok ? 0 : -si->exit.rval;
  if (restarting(err)) return;
  int absent = err == ENOENT || err == ENOTDIR;
  char kind = 0, second = 0;
  switch (op) {
    case OP_OPEN:
    case OP_OPENAT:
    case OP_OPENAT2:
    case OP_CREAT: {
      int flags = t->flags;
      if (ok && (flags & O_PATH)) {
        kind = 's';
      } else if (ok) {
        /* O_RDWR reads too: record the read before the write. */
        if (!(flags & O_WRONLY)) kind = (flags & O_DIRECTORY) ? 'd' : 'r';
        if (wants_write(flags)) second = 'w';
      } else if (absent) {
        kind = wants_write(flags) ? 'w' : 'R';
      }
      break;
    }
    case OP_STAT:
    case OP_STATAT:
    case OP_STATX:
      kind = ok ? 's' : absent ? 'S' : 0;
      break;
    case OP_ACCESS:
    case OP_ACCESSAT:
      kind = ok || err != ENOENT ? 's' : 'S';
      break;
    case OP_READLINK:
    case OP_READLINKAT:
      kind = ok ? 'r' : absent ? 'R' : 's';
      break;
    case OP_GETDENTS:
      kind = ok ? 'd' : 0;
      break;
    case OP_CONNECT:
      if ((ok || err == EINPROGRESS) && !t->launcher) write_line(t, t->path, strlen(t->path));
      return;
    default:
      return;
  }
  if (!kind && !second) return;
  if (t->unresolved) {
    if (!t->launcher) emit_untraceable(t, "unrecordable path");
    return;
  }
  if (kind) emit(t, kind, t->path);
  if (second) emit(t, second, t->path);
}

/* After an exec: whether the task now runs the launcher, and the log a launcher points to. */
static void on_exec(struct task *t) {
  char exe[PATH_MAX];
  t->launcher = proc_link(t->tid, "exe", exe, sizeof exe) == 0 && is_launcher(exe);
  if (!t->launcher) return;
  char name[64];
  snprintf(name, sizeof name, "/proc/%d/environ", t->tid);
  int fd = open(name, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return;
  static char env[1 << 20];
  size_t len = 0;
  ssize_t n;
  while (len < sizeof env - 1 && ((n = read(fd, env + len, sizeof env - 1 - len)) > 0 || (n < 0 && errno == EINTR)))
    if (n > 0) len += (size_t)n;
  close(fd);
  env[len] = '\0';
  for (size_t at = 0; at < len; at += strlen(env + at) + 1)
    if (strncmp(env + at, "VEYRUM_TRACE=", 13) == 0 && env[at + 13]) t->log = log_index(env + at + 13);
}

static void trace_loop(void) {
  for (;;) {
    int status;
    pid_t tid = waitpid(-1, &status, __WALL);
    if (tid < 0) {
      if (errno == EINTR) continue;
      return; /* ECHILD: every traced task is gone. */
    }
    if (WIFEXITED(status) || WIFSIGNALED(status)) {
      task_remove(tid);
      continue;
    }
    if (!WIFSTOPPED(status)) continue;
    struct task *t = task_get(tid);
    int sig = WSTOPSIG(status);
    int event = (int)((unsigned)status >> 16);
    int request = PTRACE_CONT;
    long deliver = 0;
    switch (event) {
      case PTRACE_EVENT_SECCOMP: {
        struct syscall_info si;
        long n = ptrace(GET_SYSCALL_INFO, tid, (void *)sizeof si, &si);
        if (n <= 0 || si.op != INFO_SECCOMP) {
          emit_untraceable(t, "ptrace");
        } else if (on_entry(t, &si)) {
          request = PTRACE_SYSCALL;
        }
        break;
      }
      case PTRACE_EVENT_FORK:
      case PTRACE_EVENT_VFORK:
      case PTRACE_EVENT_CLONE: {
        unsigned long child = 0;
        if (ptrace(PTRACE_GETEVENTMSG, tid, 0, &child) == 0 && child > 0) {
          struct task *c = task_find((pid_t)child);
          if (!c) c = task_add((pid_t)child, t->log);
          c->log = t->log;
          c->launcher = t->launcher;
        }
        break;
      }
      case PTRACE_EVENT_EXEC: {
        /* A thread other than the leader that execs takes over the leader's id. */
        unsigned long former = 0;
        if (ptrace(PTRACE_GETEVENTMSG, tid, 0, &former) == 0 && (pid_t)former != tid) {
          struct task *f = task_find((pid_t)former);
          if (f) {
            t->log = f->log;
            task_remove((pid_t)former);
          }
        }
        on_exec(t);
        break;
      }
      case PTRACE_EVENT_STOP:
        if (sig == SIGSTOP || sig == SIGTSTP || sig == SIGTTIN || sig == SIGTTOU) {
          /* A group stop: the task stays stopped until a SIGCONT, as it would untraced. */
          ptrace(PTRACE_LISTEN, tid, 0, 0);
          continue;
        }
        break;
      case 0:
        if (sig == (SIGTRAP | 0x80)) {
          struct syscall_info si;
          if (ptrace(GET_SYSCALL_INFO, tid, (void *)sizeof si, &si) > 0) on_exit_stop(t, &si);
          else t->pending = OP_NONE;
        } else {
          deliver = sig;
        }
        break;
      default:
        break;
    }
    ptrace(request, tid, 0, (void *)deliver);
  }
}

/* ---- starting ------------------------------------------------------------------------------ */

static int read_full(int fd, void *buf, size_t len) {
  size_t at = 0;
  while (at < len) {
    ssize_t n = read(fd, (char *)buf + at, len - at);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return -1;
    at += (size_t)n;
  }
  return 0;
}

static void write_full(int fd, const void *buf, size_t len) {
  const char *p = buf;
  while (len > 0) {
    ssize_t n = write(fd, p, len);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return;
    p += n;
    len -= (size_t)n;
  }
}

/* Closes every descriptor from `from` up. */
static void close_from(int from) {
#ifdef __NR_close_range
  if (syscall(__NR_close_range, (unsigned)from, ~0U, 0) == 0) return;
#endif
  struct rlimit rl;
  int max = getrlimit(RLIMIT_NOFILE, &rl) == 0 && rl.rlim_cur < 65536 ? (int)rl.rlim_cur : 65536;
  for (int fd = from; fd < max; fd++) close(fd);
}

/* The tracer: attaches to the target once told to, reports whether it could, then traces. */
static void __attribute__((noreturn)) tracer_main(pid_t target, const char *log, int go_fd, int result_fd) {
  setsid();
  /* Keep nothing of the program's open: its parent waits for its streams to close. */
  int null = open("/dev/null", O_RDWR | O_CLOEXEC);
  if (null >= 0) {
    dup2(null, 0);
    dup2(null, 1);
    dup2(null, 2);
  }
  if (dup2(go_fd, 3) < 0 || dup2(result_fd, 4) < 0) _exit(1);
  close_from(5);
  signal(SIGPIPE, SIG_IGN);
  signal(SIGINT, SIG_IGN);
  signal(SIGHUP, SIG_IGN);
  signal(SIGQUIT, SIG_IGN);
  char go;
  if (read_full(3, &go, 1) != 0) _exit(0);
  long options = PTRACE_O_TRACESECCOMP | PTRACE_O_TRACESYSGOOD | PTRACE_O_TRACECLONE | PTRACE_O_TRACEFORK |
                 PTRACE_O_TRACEVFORK | PTRACE_O_TRACEEXEC | PTRACE_O_EXITKILL;
  int result = ptrace(PTRACE_SEIZE, target, 0, (void *)options) == 0 ? 0 : -1;
  write_full(4, &result, sizeof result);
  close(3);
  close(4);
  if (result != 0) _exit(0);
  log_index(log);
  task_add(target, 0)->launcher = 1;
  trace_loop();
  _exit(0);
}

/* Starts the tracer and waits until it is attached to this process. 0 on success. */
static int start_tracer(const char *log) {
  int to_launcher[2], to_tracer[2];
  if (pipe2(to_launcher, O_CLOEXEC) != 0) return -1;
  if (pipe2(to_tracer, O_CLOEXEC) != 0) {
    close(to_launcher[0]);
    close(to_launcher[1]);
    return -1;
  }
  pid_t self = getpid();
  pid_t middle = fork();
  if (middle == 0) {
    /* Forked twice, so the program never has the tracer as a child it could wait for. */
    pid_t tracer = fork();
    if (tracer == 0) {
      close(to_launcher[0]);
      close(to_tracer[1]);
      tracer_main(self, log, to_tracer[0], to_launcher[1]);
    }
    write_full(to_launcher[1], &tracer, sizeof tracer);
    _exit(0);
  }
  close(to_launcher[1]);
  close(to_tracer[0]);
  int result = -1;
  pid_t tracer = -1;
  if (middle > 0) {
    int status;
    while (waitpid(middle, &status, 0) < 0 && errno == EINTR) {
    }
    if (read_full(to_launcher[0], &tracer, sizeof tracer) == 0 && tracer > 0) {
      /* Under Yama, only an ancestor may attach unless it is named here. Without Yama this fails harmlessly. */
      prctl(PR_SET_PTRACER, (unsigned long)tracer, 0, 0, 0);
      char go = 1;
      write_full(to_tracer[1], &go, 1);
      if (read_full(to_launcher[0], &result, sizeof result) != 0) result = -1;
    }
  }
  close(to_launcher[0]);
  close(to_tracer[1]);
  return result;
}

static int install_filter(void) {
  struct sock_filter filter[TRACED_COUNT + 8];
  size_t n = 0;
  filter[n++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch));
  filter[n++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, NATIVE_ARCH, 1, 0);
  filter[n++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_TRACE);
  filter[n++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
#ifdef X32_BIT
  filter[n++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, X32_BIT, TRACED_COUNT + 1, 0);
#endif
  for (size_t i = 0; i < TRACED_COUNT; i++)
    filter[n++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (uint32_t)traced[i].nr,
                                               (uint8_t)(TRACED_COUNT - i), 0);
  filter[n++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
  filter[n++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_TRACE);
  struct sock_fprog program = {(unsigned short)n, filter};
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
  return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program, 0, 0);
}

/* Whether this process is traced by this program already: it then runs inside a traced tree. */
static int traced_by_launcher(void) {
  pid_t tracer = status_field(getpid(), "TracerPid");
  if (tracer <= 0) return 0;
  char exe[PATH_MAX], name[64];
  snprintf(name, sizeof name, "/proc/%d/exe", tracer);
  ssize_t n = readlink(name, exe, sizeof exe - 1);
  if (n <= 0) return 0;
  exe[n] = '\0';
  return is_launcher(exe);
}

static void record_untraceable(const char *log, const char *program) {
  char line[PATH_MAX + 8];
  int n = snprintf(line, sizeof line, "u %s\n", program);
  if (n <= 0 || (size_t)n >= sizeof line || strchr(program, '\n')) n = snprintf(line, sizeof line, "u veyrum-exec\n");
  int fd = open(log, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0600);
  if (fd < 0) return;
  write_full(fd, line, (size_t)n);
  close(fd);
}

/*
 * The program's environment: LD_PRELOAD without the preloaded tracer (next to this program), which
 * ptrace replaces here. Its own children then need nothing preloaded either; the value is what the
 * program would have seen without Veyrum.
 */
static char **program_env(void) {
  char library[PATH_MAX];
  ssize_t n = readlink("/proc/self/exe", library, sizeof library - 1);
  if (n <= 0) return environ;
  library[n] = '\0';
  char *slash = strrchr(library, '/');
  if (!slash || (size_t)(slash - library) + sizeof "/libveyrum-trace.so" > sizeof library) return environ;
  strcpy(slash, "/libveyrum-trace.so");
  struct stat lib;
  if (stat(library, &lib) != 0) return environ;
  size_t count = 0;
  while (environ[count]) count++;
  char **env = calloc(count + 1, sizeof *env);
  if (!env) return environ;
  size_t out = 0;
  for (size_t i = 0; i < count; i++) {
    if (strncmp(environ[i], "LD_PRELOAD=", 11) != 0) {
      env[out++] = environ[i];
      continue;
    }
    /* The loader splits the list on colons and spaces. */
    const char *value = environ[i] + 11;
    char *kept = malloc(strlen(environ[i]) + 1);
    if (!kept) return environ;
    size_t at = (size_t)sprintf(kept, "LD_PRELOAD=");
    size_t base = at;
    for (const char *p = value; *p;) {
      size_t len = strcspn(p, ": ");
      char entry[PATH_MAX];
      struct stat st;
      int ours = 0;
      if (len > 0 && len < sizeof entry) {
        memcpy(entry, p, len);
        entry[len] = '\0';
        ours = stat(entry, &st) == 0 && st.st_dev == lib.st_dev && st.st_ino == lib.st_ino;
      }
      if (len > 0 && !ours) {
        if (at > base) kept[at++] = ':';
        memcpy(kept + at, p, len);
        at += len;
      }
      p += len;
      if (*p) p++;
    }
    kept[at] = '\0';
    if (at > base) env[out++] = kept;
  }
  env[out] = NULL;
  return env;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    static const char usage[] = "usage: veyrum-exec <program> [argv0 [args...]]\n";
    write_full(2, usage, sizeof usage - 1);
    return 127;
  }
  const char *program = argv[1];
  struct stat own;
  if (stat("/proc/self/exe", &own) == 0) {
    own_dev = own.st_dev;
    own_ino = own.st_ino;
  }
  const char *log = getenv("VEYRUM_TRACE");
  if (log && *log && !traced_by_launcher()) {
    if (start_tracer(log) != 0 || install_filter() != 0) record_untraceable(log, program);
  }
  execve(program, argv + 2, program_env());
  int err = errno;
  char message[PATH_MAX + 64];
  int n = snprintf(message, sizeof message, "veyrum-exec: %s: %s\n", program, strerror(err));
  if (n > 0) write_full(2, message, (size_t)n < sizeof message ? (size_t)n : sizeof message - 1);
  return err == ENOENT ? 127 : 126;
}
