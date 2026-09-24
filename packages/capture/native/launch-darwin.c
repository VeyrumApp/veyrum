/*
 * veyrum-exec on macOS: starts a program a test runs, through the tracer (trace-darwin.c).
 *
 *   VEYRUM_LAUNCH=<program> DYLD_INSERT_LIBRARIES=<tracer> VEYRUM_TRACE=<log> veyrum-exec [argv0 [args...]]
 *
 * The tracer is loaded into this process, and executing the program goes through its exec hook:
 * the program is recorded and, when it is protected (a system binary, or signed with the hardened
 * runtime), replaced by its shadow copy, exactly as for the programs traced processes run. The
 * program replaces this process, so its pid, parent, standard streams, signals and exit status are
 * the ones the caller expects, and it gets this process's arguments, argv[0] included.
 * VEYRUM_LAUNCH is removed first: the program sees the environment it would have had.
 */
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern char **environ;

static void say(const char *a, const char *b, const char *c) {
  const char *parts[] = {"veyrum-exec: ", a, b, c, "\n"};
  for (size_t i = 0; i < sizeof parts / sizeof *parts; i++)
    if (parts[i] && write(2, parts[i], strlen(parts[i])) < 0) return;
}

int main(int argc, char **argv) {
  (void)argc;
  const char *target = getenv("VEYRUM_LAUNCH");
  char program[PATH_MAX];
  if (!target || !*target || strlen(target) >= sizeof program) {
    say("VEYRUM_LAUNCH names no program", NULL, NULL);
    return 127;
  }
  strcpy(program, target);
  unsetenv("VEYRUM_LAUNCH");
  /* Without the tracer the program would run unobserved: the log records it as untraceable. */
  const char *log = getenv("VEYRUM_TRACE");
  if (!dlsym(RTLD_DEFAULT, "veyrum_trace_loaded") && log && *log) {
    int fd = open(log, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0600);
    if (fd >= 0) {
      const char *parts[] = {"u ", program, "\n"};
      for (size_t i = 0; i < 3; i++)
        if (write(fd, parts[i], strlen(parts[i])) < 0) break;
      close(fd);
    }
  }
  execve(program, argv, environ);
  int error = errno;
  say(program, ": ", strerror(error));
  return error == ENOENT ? 127 : 126;
}
