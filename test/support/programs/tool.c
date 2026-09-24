/*
 * A statically linked test program: runs each <operation> <argument> pair in order, the way a
 * test's helper binaries would. Built by test/support/programs.ts.
 *
 *   read <file>     prints the file          stat <path>     checks it exists
 *   list <dir>      lists it                 thread <file>   reads it from another thread
 *   fork <file>     reads it in a child      exec <program>  runs it in place of this one
 *   argv0 -         prints argv[0]           exit <code>     exits with the code
 */
#include <dirent.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

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
    }
  }
  return 0;
}
