/*
 * A test program, statically linked or not: runs each <operation> <argument> pair in order, the way
 * a test's helper binaries would. Built by test/support/programs.ts.
 *
 *   read <file>     prints the file          stat <path>     checks it exists
 *   list <dir>      lists it                 thread <file>   reads it from another thread
 *   fork <file>     reads it in a child      exec <program>  runs it in place of this one
 *   argv0 -         prints argv[0]           exit <code>     exits with the code
 *   wait -          reads standard input to its end
 *
 * On Linux, also as ptrace-based tools do (debuggers, strace):
 *
 *   trace <program> [args...]  runs the program (with the remaining arguments) under this
 *                              process's ptrace and prints the name of each program it executes
 *   attach <program>           runs `<program> wait -`, attaches to it and prints whether it could
 *   seccomp trace              installs a filter that stops getppid for a tracer, and calls it
 *   seccomp listen             installs a filter that hands acct to a supervisor
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#ifdef __linux__
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/syscall.h>

/* The name of the program process `pid` runs, or "?". */
static const char *program_of(pid_t pid, char *out, size_t cap) {
  char link[64];
  snprintf(link, sizeof link, "/proc/%d/exe", (int)pid);
  ssize_t n = readlink(link, out, cap - 1);
  if (n <= 0) return "?";
  out[n] = '\0';
  const char *slash = strrchr(out, '/');
  return slash ? slash + 1 : out;
}

/* Runs argv[0] under this process's ptrace, as a debugger does: returns its exit status. */
static int trace(char **argv) {
  pid_t child = fork();
  if (child == 0) {
    ptrace(PTRACE_TRACEME, 0, NULL, NULL);
    execv(argv[0], argv);
    _exit(127);
  }
  int status;
  while (waitpid(child, &status, 0) == child && WIFSTOPPED(status)) {
    int sig = WSTOPSIG(status);
    /* Without tracing options, an exec stops the program with SIGTRAP. */
    if (sig == SIGTRAP) {
      char exe[PATH_MAX];
      printf("exec %s\n", program_of(child, exe, sizeof exe));
      fflush(stdout);
      sig = 0;
    }
    ptrace(PTRACE_CONT, child, NULL, (void *)(long)sig);
  }
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128;
}

/* Starts `program wait -`, attaches to it once it runs that program, and prints whether it could. */
static void attach(const char *program) {
  char want[PATH_MAX];
  if (!realpath(program, want)) return;
  int fds[2];
  if (pipe(fds) != 0) return;
  pid_t child = fork();
  if (child == 0) {
    dup2(fds[0], 0);
    close(fds[0]);
    close(fds[1]);
    execl(program, program, "wait", "-", (char *)NULL);
    _exit(127);
  }
  close(fds[0]);
  char exe[PATH_MAX];
  struct timespec pause = {0, 10 * 1000 * 1000};
  for (int i = 0; i < 1000; i++) {
    program_of(child, exe, sizeof exe);
    if (strcmp(exe, want) == 0) break;
    nanosleep(&pause, NULL);
  }
  long r = ptrace(PTRACE_SEIZE, child, NULL, NULL);
  printf("%s\n", r == 0 ? "attached" : "refused");
  fflush(stdout);
  close(fds[1]);
  int status;
  while (waitpid(child, &status, 0) == child && WIFSTOPPED(status))
    ptrace(PTRACE_CONT, child, NULL, (void *)(long)WSTOPSIG(status));
}

/* Installs a seccomp filter for one system call: for a tracer ("trace") or a supervisor ("listen"). */
static void filter(const char *kind) {
  int listen = strcmp(kind, "listen") == 0;
  struct sock_filter code[] = {
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, listen ? __NR_acct : __NR_getppid, 0, 1),
      BPF_STMT(BPF_RET | BPF_K, listen ? SECCOMP_RET_USER_NOTIF : SECCOMP_RET_TRACE),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = {sizeof code / sizeof *code, code};
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return;
  long fd = syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, listen ? SECCOMP_FILTER_FLAG_NEW_LISTENER : 0, &program);
  /* Without a tracer, the call the filter stops fails. */
  if (fd >= 0 && !listen) syscall(__NR_getppid);
}
#endif

static void *print_file(void *path) {
  char buf[4096];
  int fd = open(path, O_RDONLY);
  if (fd < 0) return NULL;
  ssize_t n;
  while ((n = read(fd, buf, sizeof buf)) > 0)
    if (write(1, buf, (size_t)n) != n) break;
  close(fd);
  return NULL;
}

int main(int argc, char **argv) {
  for (int i = 1; i + 1 < argc; i += 2) {
    const char *op = argv[i], *arg = argv[i + 1];
    if (!strcmp(op, "read")) {
      print_file((void *)arg);
    } else if (!strcmp(op, "stat")) {
      struct stat st;
      printf("%s\n", stat(arg, &st) == 0 ? "present" : "absent");
      fflush(stdout);
    } else if (!strcmp(op, "list")) {
      DIR *d = opendir(arg);
      struct dirent *e;
      while (d && (e = readdir(d)))
        if (e->d_name[0] != '.') printf("%s\n", e->d_name);
      if (d) closedir(d);
      fflush(stdout);
    } else if (!strcmp(op, "thread")) {
      pthread_t t;
      pthread_create(&t, NULL, print_file, (void *)arg);
      pthread_join(t, NULL);
    } else if (!strcmp(op, "fork")) {
      pid_t child = fork();
      if (child == 0) {
        print_file((void *)arg);
        _exit(0);
      }
      waitpid(child, NULL, 0);
    } else if (!strcmp(op, "exec")) {
      execl(arg, arg, (char *)NULL);
      return 99;
    } else if (!strcmp(op, "argv0")) {
      printf("%s\n", argv[0]);
      fflush(stdout);
    } else if (!strcmp(op, "exit")) {
      return atoi(arg);
    } else if (!strcmp(op, "wait")) {
      char buf[256];
      while (read(0, buf, sizeof buf) > 0) {
      }
#ifdef __linux__
    } else if (!strcmp(op, "trace")) {
      return trace(argv + i + 1);
    } else if (!strcmp(op, "attach")) {
      attach(arg);
    } else if (!strcmp(op, "seccomp")) {
      filter(arg);
#endif
    }
  }
  return 0;
}
