/*
 * veyrum-exec.exe: starts a program a test runs on Windows with the tracer (veyrum-trace.dll, found
 * next to this program) loaded into it, waits for it and exits with its exit code. The tracer then
 * follows everything the program starts.
 *
 *   veyrum-exec [-c] <program> <command line>
 *
 * Capture relaunches a spawn through this with the program Node resolved (quoted when it has
 * spaces) and, after one space, the exact command line Node would have given the program: this
 * passes it on unchanged, so the program sees the arguments it would have seen. `-c` is accepted
 * before the program, for calls that can only name a shell (exec). The program inherits this
 * process's environment, working directory, standard streams (the CRT's descriptor table
 * included), console and window settings.
 *
 * The caller sees this process: its pid, and the program's exit code. A job object ties the program
 * to it: when this process is terminated (ChildProcess.kill), the program ends too. Programs the
 * program starts are not in that job, as a process Node starts directly does not take its
 * descendants with it.
 *
 * When the tracer cannot be loaded into the program (a 32-bit program), it runs untraced and the
 * log (VEYRUM_TRACE) records it as untraceable ("u"), which ends reuse.
 */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <windows.h>
#include <stdio.h>
#include <string.h>

#include "detours.h"

static void append_log(const char *line, DWORD len) {
  WCHAR log[32768];
  DWORD n = GetEnvironmentVariableW(L"VEYRUM_TRACE", log, 32768);
  if (n == 0 || n >= 32768) return;
  HANDLE h = CreateFileW(log, FILE_APPEND_DATA | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                         NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (h == INVALID_HANDLE_VALUE) return;
  DWORD written;
  WriteFile(h, line, len, &written, NULL);
  CloseHandle(h);
}

/* Records that the program runs untraced. */
static void untraceable(const WCHAR *program) {
  char line[32768 * 3 + 8] = "u ";
  int n = WideCharToMultiByte(CP_UTF8, 0, program, -1, line + 2, (int)sizeof line - 4, NULL, NULL);
  size_t len = n > 1 ? (size_t)n - 1 + 2 : 2;
  for (size_t i = 2; i < len; i++)
    if (line[i] == '\n' || line[i] == '\r') line[i] = ' ';
  if (len == 2) {
    memcpy(line + 2, "program", 7);
    len = 9;
  }
  line[len++] = '\n';
  append_log(line, (DWORD)len);
}

static void fail(const char *what, const WCHAR *program) {
  fprintf(stderr, "veyrum-exec: %s %ls (error %lu)\n", what, program ? program : L"", GetLastError());
  ExitProcess(127);
}

/* Skips one token of a command line: a quoted one up to its closing quote, else up to white space. */
static const WCHAR *skip_token(const WCHAR *p, const WCHAR **start, size_t *len) {
  while (*p == L' ' || *p == L'\t') p++;
  if (*p == L'"') {
    const WCHAR *end = wcschr(p + 1, L'"');
    if (!end) return NULL;
    *start = p + 1;
    *len = (size_t)(end - p - 1);
    return end + 1;
  }
  *start = p;
  while (*p && *p != L' ' && *p != L'\t') p++;
  *len = (size_t)(p - *start);
  return p;
}

/* Ignores console interrupts: the program gets them too, and this process exits when it does. */
static BOOL WINAPI on_console_event(DWORD event) {
  (void)event;
  return TRUE;
}

int wmain(void) {
  const WCHAR *start;
  size_t len;
  const WCHAR *p = skip_token(GetCommandLineW(), &start, &len);
  if (!p) fail("cannot read its command line", NULL);
  const WCHAR *program_start;
  size_t program_len;
  const WCHAR *after = skip_token(p, &program_start, &program_len);
  if (after && program_len == 2 && wcsncmp(program_start, L"-c", 2) == 0)
    after = skip_token(after, &program_start, &program_len);
  if (!after || program_len == 0 || program_len >= 32768) fail("expects a program and a command line", NULL);
  static WCHAR program[32768];
  memcpy(program, program_start, program_len * sizeof(WCHAR));
  program[program_len] = 0;
  /* One space separates the program from the command line it gets, which is passed on as it is. */
  if (*after == L' ') after++;
  size_t rest = wcslen(after);
  WCHAR *command_line = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, (rest + 1) * sizeof(WCHAR));
  if (!command_line) fail("is out of memory for", program);
  memcpy(command_line, after, (rest + 1) * sizeof(WCHAR));

  /* The tracer, next to this program; the import table names it in the system's ANSI code page. */
  static WCHAR dll[32768];
  DWORD n = GetModuleFileNameW(NULL, dll, 32768);
  WCHAR *slash = n > 0 && n < 32768 ? wcsrchr(dll, L'\\') : NULL;
  char dll_ansi[MAX_PATH * 2] = "";
  if (slash && (size_t)(slash - dll) + 18 < 32768) {
    wcscpy(slash + 1, L"veyrum-trace.dll");
    WCHAR short_path[MAX_PATH * 2];
    UINT code_page = GetACP();
    for (int attempt = 0; attempt < 2 && !dll_ansi[0]; attempt++) {
      const WCHAR *candidate = dll;
      if (attempt == 1) {
        DWORD s = GetShortPathNameW(dll, short_path, MAX_PATH * 2);
        if (s == 0 || s >= MAX_PATH * 2) break;
        candidate = short_path;
      }
      BOOL lossy = FALSE;
      int k = code_page == CP_UTF8
                  ? WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, candidate, -1, dll_ansi, (int)sizeof dll_ansi,
                                        NULL, NULL)
                  : WideCharToMultiByte(code_page, WC_NO_BEST_FIT_CHARS, candidate, -1, dll_ansi,
                                        (int)sizeof dll_ansi, NULL, &lossy);
      if (k <= 0 || lossy) dll_ansi[0] = 0;
    }
    if (GetFileAttributesW(dll) == INVALID_FILE_ATTRIBUTES) dll_ansi[0] = 0;
  }

  STARTUPINFOW startup;
  GetStartupInfoW(&startup);
  startup.cb = sizeof startup;
  /* A process without a console starts the program without one too, as its caller would have. */
  DWORD flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;
  if (GetConsoleCP() == 0) flags |= DETACHED_PROCESS;
  else if (GetConsoleWindow() == NULL) flags |= CREATE_NO_WINDOW;

  PROCESS_INFORMATION info;
  if (!CreateProcessW(program, command_line, NULL, NULL, TRUE, flags, NULL, NULL, &startup, &info))
    fail("cannot start", program);

  LPCSTR dlls[1] = {dll_ansi};
  if (!dll_ansi[0] || !DetourUpdateProcessWithDll(info.hProcess, dlls, 1)) untraceable(program);

  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (job) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    memset(&limits, 0, sizeof limits);
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits) ||
        !AssignProcessToJobObject(job, info.hProcess)) {
      CloseHandle(job);
      job = NULL;
    }
  }
  SetConsoleCtrlHandler(on_console_event, TRUE);
  if (ResumeThread(info.hThread) == (DWORD)-1) {
    TerminateProcess(info.hProcess, 127);
    fail("cannot resume", program);
  }
  CloseHandle(info.hThread);
  WaitForSingleObject(info.hProcess, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(info.hProcess, &code);
  ExitProcess(code);
}
