/*
 * Veyrum's child-process tracer for Windows: veyrum-trace.dll, loaded into every process a test
 * starts (through veyrum-exec, exec-win.c) and into everything those processes start in turn.
 *
 * It appends the events of trace.c's format to the file named by VEYRUM_TRACE, one line each:
 *
 *   r <path>  opened for reading          R <path>  open for reading failed: absent
 *   s <path>  status checked (exists)     S <path>  status checked: absent
 *   d <path>  directory listed            w <path>  created, written, renamed or removed
 *   x <path>  executed (traceable)        u <what>  something that cannot be traced
 *   n <host> <port>  connected to a network address, or to unix:<path> 0 for a Unix socket
 *
 * Paths are absolute Win32 paths in UTF-8 (C:\dir\file, \\server\share\file), spelled as the
 * program named them where the system keeps that spelling.
 *
 * What is hooked, with Microsoft Detours. File access is observed where every Win32 and C runtime
 * function ends up, in ntdll: NtCreateFile and NtOpenFile (reads and writes by the access and
 * disposition asked for), NtQueryAttributesFile, NtQueryFullAttributesFile and
 * NtQueryInformationByName (status checks), NtQueryDirectoryFile(Ex) (listings, or a check of one
 * name when the query names one), NtSetInformationFile (renames, links, deletions), NtDeleteFile
 * and NtFsControlFile (reading and setting reparse points). DLLs the program loads after it starts
 * are opened through the same functions. Processes are created through CreateProcessInternalW,
 * where CreateProcess and its variants meet: the new process starts suspended, gets this DLL in
 * its import table (DetourUpdateProcessWithDll) and its environment keeps VEYRUM_TRACE, so its
 * descendants stay traced. Connections go through connect, WSAConnect, ConnectEx (handed out by
 * WSAIoctl) and WSAConnectByName.
 *
 * Soundness notes. A process created any other way (NtCreateUserProcess called directly), one this
 * DLL cannot be loaded into (a 32-bit program), a file opened by its ID, and a path in a namespace
 * that cannot be mapped to a Win32 path are reported as untraceable ("u"), which ends reuse. The
 * DLLs a program links against are loaded before this DLL starts, like the libraries the dynamic
 * loader maps on Linux; a program that makes system calls itself instead of calling ntdll is not
 * seen (Windows system call numbers change between releases, so programs do not).
 */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <mswsock.h>
#include <windows.h>
#include <winternl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "advapi32.lib")

/* detours.h uses nameless unions, a Microsoft extension. */
#pragma warning(push)
#pragma warning(disable : 4201)
#include "detours.h"
#pragma warning(pop)

/* ---- NT definitions winternl.h leaves out ------------------------------------------------------ */

#define ST_SUCCESS ((NTSTATUS)0x00000000L)
#define ST_PENDING ((NTSTATUS)0x00000103L)
#define ST_NO_SUCH_FILE ((NTSTATUS)0xC000000FL)
#define ST_NAME_NOT_FOUND ((NTSTATUS)0xC0000034L)
#define ST_PATH_NOT_FOUND ((NTSTATUS)0xC000003AL)
#define ST_NOT_A_DIRECTORY ((NTSTATUS)0xC0000103L)
#define ST_NO_MORE_FILES ((NTSTATUS)0x80000006L)

#ifndef FILE_SUPERSEDE
#define FILE_SUPERSEDE 0x00000000
#define FILE_OPEN 0x00000001
#define FILE_CREATE 0x00000002
#define FILE_OPEN_IF 0x00000003
#define FILE_OVERWRITE 0x00000004
#define FILE_OVERWRITE_IF 0x00000005
#endif
#ifndef FILE_DELETE_ON_CLOSE
#define FILE_DELETE_ON_CLOSE 0x00001000
#endif
#ifndef FILE_OPEN_BY_FILE_ID
#define FILE_OPEN_BY_FILE_ID 0x00002000
#endif

/* NtSetInformationFile classes. */
#define INFO_RENAME 10
#define INFO_LINK 11
#define INFO_DISPOSITION 13
#define INFO_DISPOSITION_EX 64
#define INFO_RENAME_EX 65
#define INFO_RENAME_EX_BYPASS 66
#define INFO_LINK_EX 72
#define INFO_LINK_EX_BYPASS 73
/* NtQueryInformationFile class of the file's ID, for checking the log's handle. */
#define INFO_INTERNAL 6

#define FSCTL_SET_REPARSE 0x000900A4
#define FSCTL_GET_REPARSE 0x000900A8
#define FSCTL_DELETE_REPARSE 0x000900AC

/* FILE_RENAME_INFORMATION and FILE_LINK_INFORMATION share this layout, and so do their Ex forms. */
typedef struct {
  ULONG flags; /* ReplaceIfExists (a BOOLEAN) or Flags */
  HANDLE root;
  ULONG length;
  WCHAR name[1];
} NAME_INFO;

typedef NTSTATUS(NTAPI *NtCreateFile_t)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER,
                                        ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
typedef NTSTATUS(NTAPI *NtOpenFile_t)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, ULONG, ULONG);
typedef NTSTATUS(NTAPI *NtQueryAttributesFile_t)(POBJECT_ATTRIBUTES, PVOID);
typedef NTSTATUS(NTAPI *NtQueryInformationByName_t)(POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PVOID, ULONG, ULONG);
typedef NTSTATUS(NTAPI *NtQueryDirectoryFile_t)(HANDLE, HANDLE, PIO_APC_ROUTINE, PVOID, PIO_STATUS_BLOCK, PVOID, ULONG,
                                                ULONG, BOOLEAN, PUNICODE_STRING, BOOLEAN);
typedef NTSTATUS(NTAPI *NtQueryDirectoryFileEx_t)(HANDLE, HANDLE, PIO_APC_ROUTINE, PVOID, PIO_STATUS_BLOCK, PVOID,
                                                  ULONG, ULONG, ULONG, PUNICODE_STRING);
typedef NTSTATUS(NTAPI *NtSetInformationFile_t)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, ULONG);
typedef NTSTATUS(NTAPI *NtQueryInformationFile_t)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, ULONG);
typedef NTSTATUS(NTAPI *NtDeleteFile_t)(POBJECT_ATTRIBUTES);
typedef NTSTATUS(NTAPI *NtFsControlFile_t)(HANDLE, HANDLE, PIO_APC_ROUTINE, PVOID, PIO_STATUS_BLOCK, ULONG, PVOID, ULONG,
                                           PVOID, ULONG);
typedef NTSTATUS(NTAPI *NtQueryObject_t)(HANDLE, ULONG, PVOID, ULONG, PULONG);
typedef NTSTATUS(NTAPI *NtClose_t)(HANDLE);
typedef NTSTATUS(NTAPI *NtCreateUserProcess_t)(PHANDLE, PHANDLE, ACCESS_MASK, ACCESS_MASK, POBJECT_ATTRIBUTES,
                                               POBJECT_ATTRIBUTES, ULONG, ULONG, PVOID, PVOID, PVOID);
typedef NTSTATUS(NTAPI *NtCreateProcessEx_t)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, HANDLE, ULONG, HANDLE, HANDLE,
                                             HANDLE, ULONG);
typedef NTSTATUS(NTAPI *NtCreateProcess_t)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, HANDLE, BOOLEAN, HANDLE, HANDLE,
                                           HANDLE);
typedef VOID(NTAPI *RtlPebLock_t)(VOID);
typedef BOOL(WINAPI *CreateProcessInternalW_t)(HANDLE, LPCWSTR, LPWSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES,
                                               BOOL, DWORD, LPVOID, LPCWSTR, LPSTARTUPINFOW, LPPROCESS_INFORMATION,
                                               PHANDLE);
typedef int(WSAAPI *connect_t)(SOCKET, const struct sockaddr *, int);
typedef int(WSAAPI *WSAConnect_t)(SOCKET, const struct sockaddr *, int, LPWSABUF, LPWSABUF, LPQOS, LPQOS);
typedef int(WSAAPI *WSAIoctl_t)(SOCKET, DWORD, LPVOID, DWORD, LPVOID, DWORD, LPDWORD, LPWSAOVERLAPPED,
                                LPWSAOVERLAPPED_COMPLETION_ROUTINE);
typedef BOOL(WSAAPI *WSAConnectByNameW_t)(SOCKET, LPWSTR, LPWSTR, LPDWORD, LPSOCKADDR, LPDWORD, LPSOCKADDR,
                                          const struct timeval *, LPWSAOVERLAPPED);
typedef BOOL(WSAAPI *WSAConnectByNameA_t)(SOCKET, LPCSTR, LPCSTR, LPDWORD, LPSOCKADDR, LPDWORD, LPSOCKADDR,
                                          const struct timeval *, LPWSAOVERLAPPED);
typedef BOOL(WSAAPI *WSAConnectByList_t)(SOCKET, PSOCKET_ADDRESS_LIST, LPDWORD, LPSOCKADDR, LPDWORD, LPSOCKADDR,
                                         const struct timeval *, LPWSAOVERLAPPED);
typedef BOOL(PASCAL *ConnectEx_t)(SOCKET, const struct sockaddr *, int, PVOID, DWORD, LPDWORD, LPOVERLAPPED);

static NtCreateFile_t Real_NtCreateFile;
static NtOpenFile_t Real_NtOpenFile;
static NtQueryAttributesFile_t Real_NtQueryAttributesFile;
static NtQueryAttributesFile_t Real_NtQueryFullAttributesFile;
static NtQueryInformationByName_t Real_NtQueryInformationByName;
static NtQueryDirectoryFile_t Real_NtQueryDirectoryFile;
static NtQueryDirectoryFileEx_t Real_NtQueryDirectoryFileEx;
static NtSetInformationFile_t Real_NtSetInformationFile;
static NtQueryInformationFile_t Real_NtQueryInformationFile;
static NtDeleteFile_t Real_NtDeleteFile;
static NtFsControlFile_t Real_NtFsControlFile;
static NtQueryObject_t Real_NtQueryObject;
static NtClose_t Real_NtClose;
static NtCreateUserProcess_t Real_NtCreateUserProcess;
static NtCreateProcessEx_t Real_NtCreateProcessEx;
static NtCreateProcess_t Real_NtCreateProcess;
static RtlPebLock_t Real_RtlAcquirePebLock;
static RtlPebLock_t Real_RtlReleasePebLock;
static CreateProcessInternalW_t Real_CreateProcessInternalW;
static connect_t Real_connect;
static WSAConnect_t Real_WSAConnect;
static WSAIoctl_t Real_WSAIoctl;
static WSAConnectByNameW_t Real_WSAConnectByNameW;
static WSAConnectByNameA_t Real_WSAConnectByNameA;
static WSAConnectByList_t Real_WSAConnectByList;

/* ---- state -------------------------------------------------------------------------------------- */

static HMODULE self_module;
static int tracing;
static HANDLE log_handle = INVALID_HANDLE_VALUE;
static LARGE_INTEGER log_id;
static WCHAR trace_value[32768];
/* This DLL's path as the loader reads it from an import table (ANSI), or empty when it has none. */
static char dll_path_ansi[MAX_PATH * 2];

/* Set while recording, so what the recording itself calls is not recorded. */
static __declspec(thread) int busy;
/* Set while this DLL creates a process, so the system call that does it is expected. */
static __declspec(thread) int creating;

#define MAX_NAME 32768
/* Per-thread buffers: paths can be 32767 characters long, too much for some threads' stacks. */
typedef struct {
  WCHAR path[MAX_NAME + 64];
  WCHAR base[MAX_NAME + 64];
  /* Also holds UTF-16 and NT structures while a path is worked out. */
  __declspec(align(16)) char line[MAX_NAME * 3 + 16];
  char last[1024];
  DWORD last_len;
} SCRATCH;
static __declspec(thread) SCRATCH *scratch;

static SCRATCH *get_scratch(void) {
  if (!scratch) scratch = (SCRATCH *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(SCRATCH));
  return scratch;
}

/* ---- logging ------------------------------------------------------------------------------------ */

static HANDLE log_open(void) {
  HANDLE h = CreateFileW(trace_value, FILE_APPEND_DATA | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                         NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (h == INVALID_HANDLE_VALUE) return h;
  IO_STATUS_BLOCK io;
  if (!Real_NtQueryInformationFile || Real_NtQueryInformationFile(h, &io, &log_id, sizeof log_id, INFO_INTERNAL) < 0)
    log_id.QuadPart = -1;
  return h;
}

/*
 * Appends one whole line (a single write to a handle opened for appending only, which the file
 * system appends at the end in one piece). The handle is checked first: a program that closes
 * handles it does not own could leave another file at its value.
 */
static void log_write(const char *buf, DWORD len) {
  HANDLE h = log_handle;
  LARGE_INTEGER id;
  IO_STATUS_BLOCK io;
  if (h == INVALID_HANDLE_VALUE || Real_NtQueryInformationFile(h, &io, &id, sizeof id, INFO_INTERNAL) < 0 ||
      id.QuadPart != log_id.QuadPart) {
    h = log_open();
    if (h == INVALID_HANDLE_VALUE) return;
    log_handle = h;
  }
  DWORD written;
  WriteFile(h, buf, len, &written, NULL);
}

/* Writes a line unless it repeats the line this thread wrote last (a listing read in parts). */
static void log_line(SCRATCH *s, const char *line, DWORD len) {
  if (len == s->last_len && memcmp(line, s->last, len) == 0) return;
  log_write(line, len);
  if (len <= sizeof s->last) {
    memcpy(s->last, line, len);
    s->last_len = len;
  } else {
    s->last_len = 0;
  }
}

static void emit_text(char kind, const char *text) {
  SCRATCH *s = get_scratch();
  if (!s) return;
  size_t n = strlen(text);
  if (n > sizeof s->line - 4) n = sizeof s->line - 4;
  s->line[0] = kind;
  s->line[1] = ' ';
  memcpy(s->line + 2, text, n);
  for (size_t i = 0; i < n; i++)
    if (s->line[2 + i] == '\n' || s->line[2 + i] == '\r') s->line[2 + i] = ' ';
  s->line[2 + n] = '\n';
  log_line(s, s->line, (DWORD)(n + 3));
}

/* Records a path (UTF-16, `len` characters). A path UTF-8 cannot carry faithfully is untraceable. */
static void emit_path(char kind, const WCHAR *path, size_t len) {
  SCRATCH *s = get_scratch();
  if (!s || len == 0) return;
  for (size_t i = 0; i < len; i++) {
    if (path[i] == L'\n' || path[i] == L'\r') {
      emit_text('u', "unrecordable path");
      return;
    }
  }
  int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, path, (int)len, s->line + 2, (int)sizeof s->line - 4, NULL,
                              NULL);
  if (n <= 0) {
    emit_text('u', "unrecordable path");
    return;
  }
  s->line[0] = kind;
  s->line[1] = ' ';
  s->line[2 + n] = '\n';
  log_line(s, s->line, (DWORD)(n + 3));
}

/* ---- paths -------------------------------------------------------------------------------------- */

/* What a native name turned out to be. */
enum { PATH_NONE = 0, PATH_FILE = 1, PATH_UNKNOWN = -1 };

static int starts_with(const WCHAR *s, size_t n, const WCHAR *prefix) {
  size_t k = wcslen(prefix);
  if (n < k) return 0;
  for (size_t i = 0; i < k; i++) {
    WCHAR a = s[i], b = prefix[i];
    if (a >= L'a' && a <= L'z') a = (WCHAR)(a - 32);
    if (b >= L'a' && b <= L'z') b = (WCHAR)(b - 32);
    if (a != b) return 0;
  }
  return 1;
}

static int equals(const WCHAR *s, size_t n, const WCHAR *other) { return n == wcslen(other) && starts_with(s, n, other); }

static int is_letter(WCHAR c) { return (c >= L'A' && c <= L'Z') || (c >= L'a' && c <= L'z'); }

/* Copies `n` characters after `prefix` into out; the first character of `text`, a drive letter, is upper-cased. */
static int put(WCHAR *out, size_t cap, size_t *len, const WCHAR *prefix, const WCHAR *text, size_t n, int drive) {
  size_t p = wcslen(prefix);
  if (p + n + 1 > cap) return PATH_UNKNOWN;
  memcpy(out, prefix, p * sizeof(WCHAR));
  memcpy(out + p, text, n * sizeof(WCHAR));
  if (drive && p + n >= 2 && out[1] == L':' && out[0] >= L'a' && out[0] <= L'z') out[0] = (WCHAR)(out[0] - 32);
  *len = p + n;
  out[*len] = 0;
  return PATH_FILE;
}

/* Drive letters and the devices they name (\Device\HarddiskVolume3), found once. */
static WCHAR drive_devices[26][128];
static INIT_ONCE drives_once = INIT_ONCE_STATIC_INIT;

static BOOL CALLBACK find_drives(PINIT_ONCE once, PVOID param, PVOID *context) {
  (void)once;
  (void)param;
  (void)context;
  for (int i = 0; i < 26; i++) {
    WCHAR name[3] = {(WCHAR)(L'A' + i), L':', 0};
    if (!QueryDosDeviceW(name, drive_devices[i], 128)) drive_devices[i][0] = 0;
  }
  return TRUE;
}

/*
 * The Win32 path for a native path (\??\C:\x, \Device\HarddiskVolume3\x, \??\UNC\server\share\x).
 * PATH_NONE for what is not a file (pipes, consoles, other devices), PATH_UNKNOWN for a file this
 * cannot name.
 */
static int native_to_win32(const WCHAR *name, size_t n, WCHAR *out, size_t cap, size_t *len) {
  const WCHAR *rest = NULL;
  size_t r = 0;
  if (starts_with(name, n, L"\\??\\")) rest = name + 4, r = n - 4;
  else if (starts_with(name, n, L"\\DosDevices\\")) rest = name + 12, r = n - 12;
  else if (starts_with(name, n, L"\\GLOBAL??\\")) rest = name + 10, r = n - 10;
  if (rest) {
    if (r >= 2 && is_letter(rest[0]) && rest[1] == L':') {
      /* The volume itself, not a file on it. */
      if (r == 2) return PATH_NONE;
      return put(out, cap, len, L"", rest, r, 1);
    }
    if (starts_with(rest, r, L"UNC\\")) return put(out, cap, len, L"\\\\", rest + 4, r - 4, 0);
    if (starts_with(rest, r, L"GLOBALROOT\\")) return native_to_win32(rest + 10, r - 10, out, cap, len);
    if (starts_with(rest, r, L"pipe\\") || starts_with(rest, r, L"MAILSLOT\\") || equals(rest, r, L"CONIN$") ||
        equals(rest, r, L"CONOUT$") || equals(rest, r, L"CON") || equals(rest, r, L"NUL"))
      return PATH_NONE;
    return PATH_UNKNOWN;
  }
  if (starts_with(name, n, L"\\Device\\")) {
    if (starts_with(name, n, L"\\Device\\Mup\\")) return put(out, cap, len, L"\\\\", name + 12, n - 12, 0);
    InitOnceExecuteOnce(&drives_once, find_drives, NULL, NULL);
    for (int i = 0; i < 26; i++) {
      size_t d = wcslen(drive_devices[i]);
      if (d && n > d && name[d] == L'\\' && starts_with(name, n, drive_devices[i])) {
        WCHAR drive[3] = {(WCHAR)(L'A' + i), L':', 0};
        return put(out, cap, len, drive, name + d, n - d, 0);
      }
    }
    if (starts_with(name, n, L"\\Device\\HarddiskVolume") || starts_with(name, n, L"\\Device\\LanmanRedirector") ||
        starts_with(name, n, L"\\Device\\CdRom") || starts_with(name, n, L"\\Device\\Floppy") ||
        starts_with(name, n, L"\\Device\\WebDav"))
      return PATH_UNKNOWN;
    return PATH_NONE;
  }
  if (starts_with(name, n, L"\\SystemRoot\\")) {
    WCHAR windows[MAX_PATH];
    UINT w = GetSystemWindowsDirectoryW(windows, MAX_PATH);
    if (w == 0 || w >= MAX_PATH || w + (n - 11) + 1 > cap) return PATH_UNKNOWN;
    memcpy(out, windows, w * sizeof(WCHAR));
    memcpy(out + w, name + 11, (n - 11) * sizeof(WCHAR));
    *len = w + n - 11;
    out[*len] = 0;
    return PATH_FILE;
  }
  return PATH_UNKNOWN;
}

/* A Win32 path from GetFinalPathNameByHandleW: \\?\C:\x becomes C:\x, \\?\UNC\s\x becomes \\s\x. */
static int final_to_win32(const WCHAR *p, size_t n, WCHAR *out, size_t cap, size_t *len) {
  if (starts_with(p, n, L"\\\\?\\UNC\\")) return put(out, cap, len, L"\\\\", p + 8, n - 8, 0);
  if (starts_with(p, n, L"\\\\?\\")) return put(out, cap, len, L"", p + 4, n - 4, 1);
  return put(out, cap, len, L"", p, n, 1);
}

#ifdef _WIN64
/* RTL_USER_PROCESS_PARAMETERS.CurrentDirectory: the path as set, and the handle relative opens use. */
typedef struct {
  UNICODE_STRING path;
  HANDLE handle;
} CURRENT_DIRECTORY;
#define CURRENT_DIRECTORY_OFFSET 0x38
#endif

/*
 * The working directory, when `h` is the handle the system resolves relative paths against: the
 * directory as the program set it, which keeps its spelling.
 */
static int working_directory(HANDLE h, WCHAR *out, size_t cap, size_t *len) {
#ifdef _WIN64
  if (!Real_RtlAcquirePebLock || !Real_RtlReleasePebLock) return PATH_UNKNOWN;
  PPEB peb = NtCurrentTeb()->ProcessEnvironmentBlock;
  const CURRENT_DIRECTORY *cd = (const CURRENT_DIRECTORY *)((const BYTE *)peb->ProcessParameters + CURRENT_DIRECTORY_OFFSET);
  int found = PATH_UNKNOWN;
  Real_RtlAcquirePebLock();
  if (cd->handle == h && cd->path.Buffer) {
    size_t n = cd->path.Length / sizeof(WCHAR);
    /* Kept with a trailing backslash, which only a drive's root keeps here. */
    if (n > 3 && cd->path.Buffer[n - 1] == L'\\') n--;
    found = put(out, cap, len, L"", cd->path.Buffer, n, 1);
  }
  Real_RtlReleasePebLock();
  return found;
#else
  (void)h, (void)out, (void)cap, (void)len;
  return PATH_UNKNOWN;
#endif
}

/* The path of an open handle. */
static int handle_path(HANDLE h, WCHAR *out, size_t cap, size_t *len) {
  if (working_directory(h, out, cap, len) == PATH_FILE) return PATH_FILE;
  DWORD n = GetFinalPathNameByHandleW(h, out, (DWORD)cap, FILE_NAME_OPENED | VOLUME_NAME_DOS);
  if (n > 0 && n < cap) {
    SCRATCH *s = get_scratch();
    if (!s) return PATH_UNKNOWN;
    memcpy(s->line, out, n * sizeof(WCHAR));
    return final_to_win32((const WCHAR *)s->line, n, out, cap, len);
  }
  /* Not a file on a volume with a drive letter: the object's native name says what it is. */
  if (!Real_NtQueryObject) return PATH_UNKNOWN;
  SCRATCH *s = get_scratch();
  if (!s) return PATH_UNKNOWN;
  ULONG returned = 0;
  /* ObjectNameInformation: a UNICODE_STRING followed by its characters. */
  if (Real_NtQueryObject(h, 1, s->line, (ULONG)sizeof s->line, &returned) < 0) return PATH_UNKNOWN;
  const UNICODE_STRING *name = (const UNICODE_STRING *)s->line;
  if (!name->Buffer || name->Length == 0) return PATH_NONE;
  return native_to_win32(name->Buffer, name->Length / sizeof(WCHAR), out, cap, len);
}

/* Joins a directory and a relative name into out (which may hold the directory already). */
static int join(WCHAR *out, size_t cap, size_t *len, const WCHAR *name, size_t n) {
  size_t at = *len;
  int slash = at > 0 && out[at - 1] != L'\\';
  if (at + slash + n + 1 > cap) return PATH_UNKNOWN;
  if (slash) out[at++] = L'\\';
  memcpy(out + at, name, n * sizeof(WCHAR));
  at += n;
  out[at] = 0;
  *len = at;
  return PATH_FILE;
}

/* The Win32 path an OBJECT_ATTRIBUTES names, into the thread's scratch path. */
static int attributes_path(POBJECT_ATTRIBUTES oa, SCRATCH *s, size_t *len) {
  if (!oa) return PATH_NONE;
  const WCHAR *name = oa->ObjectName && oa->ObjectName->Buffer ? oa->ObjectName->Buffer : L"";
  size_t n = oa->ObjectName ? oa->ObjectName->Length / sizeof(WCHAR) : 0;
  if (oa->RootDirectory) {
    /* Invalid: the call fails and nothing is opened. */
    if (n > 0 && name[0] == L'\\') return PATH_NONE;
    int kind = handle_path(oa->RootDirectory, s->path, MAX_NAME, len);
    if (kind != PATH_FILE || n == 0) return kind;
    return join(s->path, MAX_NAME, len, name, n);
  }
  if (n == 0 || name[0] != L'\\') return PATH_NONE;
  return native_to_win32(name, n, s->path, MAX_NAME, len);
}

static int absent(NTSTATUS st) {
  return st == ST_NAME_NOT_FOUND || st == ST_PATH_NOT_FOUND || st == ST_NO_SUCH_FILE || st == ST_NOT_A_DIRECTORY;
}

/* Runs a recording with the program's last error kept: the recording's own calls may change it. */
#define RECORD(body)                  \
  do {                                \
    if (tracing && !busy) {           \
      DWORD saved_error = GetLastError(); \
      busy = 1;                       \
      body;                           \
      busy = 0;                       \
      SetLastError(saved_error);      \
    }                                 \
  } while (0)

/* A path this cannot name: untraceable, with the native name for whoever reads the log. */
static void emit_unknown(const WCHAR *name, size_t n) {
  char text[600];
  int k = name && n ? WideCharToMultiByte(CP_UTF8, 0, name, (int)(n < 180 ? n : 180), text + 18, 540, NULL, NULL) : 0;
  memcpy(text, "unresolvable path ", 18);
  text[18 + (k > 0 ? k : 0)] = 0;
  emit_text('u', text);
}

static void emit_attributes(char kind, POBJECT_ATTRIBUTES oa) {
  SCRATCH *s = get_scratch();
  if (!s) return;
  size_t len = 0;
  int found = attributes_path(oa, s, &len);
  if (found == PATH_FILE) emit_path(kind, s->path, len);
  else if (found == PATH_UNKNOWN && oa && oa->ObjectName)
    emit_unknown(oa->ObjectName->Buffer, oa->ObjectName->Length / sizeof(WCHAR));
  else if (found == PATH_UNKNOWN)
    emit_unknown(NULL, 0);
}

static void emit_handle(char kind, HANDLE h) {
  SCRATCH *s = get_scratch();
  if (!s) return;
  size_t len = 0;
  int found = handle_path(h, s->path, MAX_NAME, &len);
  if (found == PATH_FILE) emit_path(kind, s->path, len);
  else if (found == PATH_UNKNOWN) emit_unknown(NULL, 0);
}

/* ---- opening files ------------------------------------------------------------------------------ */

#define READS (FILE_READ_DATA | FILE_EXECUTE | GENERIC_READ | GENERIC_EXECUTE | GENERIC_ALL | MAXIMUM_ALLOWED)
#define WRITES (FILE_WRITE_DATA | FILE_APPEND_DATA | GENERIC_WRITE | GENERIC_ALL)

static void opened(POBJECT_ATTRIBUTES oa, ACCESS_MASK access, ULONG disposition, ULONG options, NTSTATUS st) {
  if (options & FILE_OPEN_BY_FILE_ID) {
    emit_text('u', "file opened by id");
    return;
  }
  int writes = (access & WRITES) != 0 || (options & FILE_DELETE_ON_CLOSE) != 0 || disposition == FILE_SUPERSEDE ||
               disposition == FILE_CREATE || disposition == FILE_OVERWRITE || disposition == FILE_OVERWRITE_IF ||
               disposition == FILE_OPEN_IF;
  int reads = (access & READS) != 0;
  if (st >= 0 && st != ST_PENDING) {
    /* Reading and writing: the read comes first, so it stays an input. */
    if (reads) emit_attributes('r', oa);
    if (writes) emit_attributes('w', oa);
    if (!reads && !writes) emit_attributes('s', oa);
  } else if (absent(st)) {
    emit_attributes(writes ? 'w' : reads ? 'R' : 'S', oa);
  } else {
    /* Refused (access, sharing): the path exists, or its absence is found when it is recorded. */
    emit_attributes('s', oa);
  }
}

static NTSTATUS NTAPI Hook_NtCreateFile(PHANDLE h, ACCESS_MASK access, POBJECT_ATTRIBUTES oa, PIO_STATUS_BLOCK io,
                                        PLARGE_INTEGER size, ULONG attributes, ULONG share, ULONG disposition,
                                        ULONG options, PVOID ea, ULONG ea_length) {
  NTSTATUS st = Real_NtCreateFile(h, access, oa, io, size, attributes, share, disposition, options, ea, ea_length);
  RECORD(opened(oa, access, disposition, options, st));
  return st;
}

static NTSTATUS NTAPI Hook_NtOpenFile(PHANDLE h, ACCESS_MASK access, POBJECT_ATTRIBUTES oa, PIO_STATUS_BLOCK io,
                                      ULONG share, ULONG options) {
  NTSTATUS st = Real_NtOpenFile(h, access, oa, io, share, options);
  RECORD(opened(oa, access, FILE_OPEN, options, st));
  return st;
}

/* ---- status checks ------------------------------------------------------------------------------ */

static void checked(POBJECT_ATTRIBUTES oa, NTSTATUS st) { emit_attributes(absent(st) ? 'S' : 's', oa); }

static NTSTATUS NTAPI Hook_NtQueryAttributesFile(POBJECT_ATTRIBUTES oa, PVOID info) {
  NTSTATUS st = Real_NtQueryAttributesFile(oa, info);
  RECORD(checked(oa, st));
  return st;
}

static NTSTATUS NTAPI Hook_NtQueryFullAttributesFile(POBJECT_ATTRIBUTES oa, PVOID info) {
  NTSTATUS st = Real_NtQueryFullAttributesFile(oa, info);
  RECORD(checked(oa, st));
  return st;
}

static NTSTATUS NTAPI Hook_NtQueryInformationByName(POBJECT_ATTRIBUTES oa, PIO_STATUS_BLOCK io, PVOID info,
                                                    ULONG length, ULONG cls) {
  NTSTATUS st = Real_NtQueryInformationByName(oa, io, info, length, cls);
  RECORD(checked(oa, st));
  return st;
}

/* ---- directories -------------------------------------------------------------------------------- */

static int has_wildcard(const UNICODE_STRING *pattern) {
  size_t n = pattern->Length / sizeof(WCHAR);
  for (size_t i = 0; i < n; i++) {
    WCHAR c = pattern->Buffer[i];
    /* The native wildcards include the DOS forms FindFirstFile translates * and ? into. */
    if (c == L'*' || c == L'?' || c == L'<' || c == L'>' || c == L'"') return 1;
  }
  return 0;
}

/*
 * Directory handles already queried, and whether their first query named a single entry: a query
 * without a name continues the first one (FindNextFile after FindFirstFile), so after a named one
 * it lists nothing. Entries leave when their handle is closed; one pushed out by newer ones only
 * makes a later continuation count as a listing.
 */
#define QUERIED_HANDLES 64
typedef struct {
  HANDLE handle;
  uint64_t directory; /* a hash of the directory's path, against a handle value reused unseen */
  int named;
} QUERIED;
static QUERIED queried_handles[QUERIED_HANDLES];
static volatile LONG queried_count;
static unsigned queried_next;
static SRWLOCK queried_lock = SRWLOCK_INIT;

static uint64_t path_hash(const WCHAR *p, size_t n) {
  uint64_t h = 14695981039346656037ULL;
  for (size_t i = 0; i < n; i++) h = (h ^ p[i]) * 1099511628211ULL;
  return h;
}

/* Whether the handle's earlier query named one entry; records the handle as queried now. */
static int continues_named(HANDLE h, uint64_t directory, int named, int first_only) {
  int result = 0;
  AcquireSRWLockExclusive(&queried_lock);
  int found = -1;
  for (int i = 0; i < QUERIED_HANDLES; i++)
    if (queried_handles[i].handle == h && queried_handles[i].directory == directory) found = i;
  if (found >= 0) {
    result = queried_handles[found].named;
    /* A later query with a pattern of its own may start over with it: never back to one name. */
    if (!first_only) queried_handles[found].named = queried_handles[found].named && named;
  } else {
    unsigned slot = queried_next++ % QUERIED_HANDLES;
    if (!queried_handles[slot].handle) InterlockedIncrement(&queried_count);
    queried_handles[slot].handle = h;
    queried_handles[slot].directory = directory;
    queried_handles[slot].named = named;
  }
  ReleaseSRWLockExclusive(&queried_lock);
  return found >= 0 ? result : -1;
}

static NTSTATUS NTAPI Hook_NtClose(HANDLE h) {
  if (queried_count > 0) {
    AcquireSRWLockExclusive(&queried_lock);
    for (int i = 0; i < QUERIED_HANDLES; i++) {
      if (queried_handles[i].handle == h) {
        queried_handles[i].handle = NULL;
        InterlockedDecrement(&queried_count);
      }
    }
    ReleaseSRWLockExclusive(&queried_lock);
  }
  return Real_NtClose(h);
}

/*
 * A directory query lists the directory, unless it names one entry: then it checks that name
 * (FindFirstFile on a path without wildcards), and the queries continuing it list nothing.
 */
static void queried(HANDLE h, const UNICODE_STRING *pattern, NTSTATUS st) {
  SCRATCH *s = get_scratch();
  if (!s) return;
  size_t len = 0;
  int found = handle_path(h, s->path, MAX_NAME, &len);
  if (found == PATH_NONE) return;
  if (found == PATH_UNKNOWN) {
    emit_unknown(NULL, 0);
    return;
  }
  uint64_t directory = path_hash(s->path, len);
  int has_pattern = pattern && pattern->Buffer && pattern->Length > 0;
  int named = has_pattern && !has_wildcard(pattern) && st != ST_PENDING;
  int earlier = continues_named(h, directory, named, !has_pattern);
  if (named) {
    if (join(s->path, MAX_NAME, &len, pattern->Buffer, pattern->Length / sizeof(WCHAR)) != PATH_FILE) {
      emit_unknown(NULL, 0);
      return;
    }
    emit_path(st >= 0 ? 's' : (absent(st) || st == ST_NO_MORE_FILES ? 'S' : 's'), s->path, len);
    /* Continuing a listing with a name: the query may go on with the listing's pattern. */
    if (earlier == 0) emit_handle('d', h);
    return;
  }
  if (!has_pattern && earlier == 1) return;
  emit_path('d', s->path, len);
}

static NTSTATUS NTAPI Hook_NtQueryDirectoryFile(HANDLE h, HANDLE event, PIO_APC_ROUTINE apc, PVOID context,
                                                PIO_STATUS_BLOCK io, PVOID info, ULONG length, ULONG cls,
                                                BOOLEAN single, PUNICODE_STRING pattern, BOOLEAN restart) {
  NTSTATUS st = Real_NtQueryDirectoryFile(h, event, apc, context, io, info, length, cls, single, pattern, restart);
  RECORD(queried(h, pattern, st));
  return st;
}

static NTSTATUS NTAPI Hook_NtQueryDirectoryFileEx(HANDLE h, HANDLE event, PIO_APC_ROUTINE apc, PVOID context,
                                                  PIO_STATUS_BLOCK io, PVOID info, ULONG length, ULONG cls,
                                                  ULONG flags, PUNICODE_STRING pattern) {
  NTSTATUS st = Real_NtQueryDirectoryFileEx(h, event, apc, context, io, info, length, cls, flags, pattern);
  RECORD(queried(h, pattern, st));
  return st;
}

/* ---- writes ------------------------------------------------------------------------------------- */

/* The target of a rename or link: a full native path, a path relative to a handle, or a name in the source's directory. */
static void emit_target(char kind, HANDLE source, const NAME_INFO *info, ULONG length) {
  SCRATCH *s = get_scratch();
  if (!s) return;
  if (length < offsetof(NAME_INFO, name) || info->length > length - offsetof(NAME_INFO, name)) {
    emit_unknown(NULL, 0);
    return;
  }
  const WCHAR *name = info->name;
  size_t n = info->length / sizeof(WCHAR);
  size_t len = 0;
  int found;
  if (info->root) {
    found = handle_path(info->root, s->path, MAX_NAME, &len);
    if (found == PATH_FILE) found = join(s->path, MAX_NAME, &len, name, n);
  } else if (n > 0 && name[0] == L'\\') {
    found = native_to_win32(name, n, s->path, MAX_NAME, &len);
  } else {
    found = handle_path(source, s->path, MAX_NAME, &len);
    if (found == PATH_FILE) {
      while (len > 0 && s->path[len - 1] != L'\\') len--;
      if (len > 0) len--;
      found = join(s->path, MAX_NAME, &len, name, n);
    }
  }
  if (found == PATH_FILE) emit_path(kind, s->path, len);
  else if (found == PATH_UNKNOWN) emit_unknown(NULL, 0);
}

static void set_information(HANDLE h, PVOID info, ULONG length, ULONG cls) {
  switch (cls) {
    case INFO_RENAME:
    case INFO_RENAME_EX:
    case INFO_RENAME_EX_BYPASS:
      emit_handle('w', h);
      emit_target('w', h, (const NAME_INFO *)info, length);
      break;
    case INFO_LINK:
    case INFO_LINK_EX:
    case INFO_LINK_EX_BYPASS:
      emit_handle('r', h);
      emit_target('w', h, (const NAME_INFO *)info, length);
      break;
    case INFO_DISPOSITION:
      if (length >= 1 && *(const BOOLEAN *)info) emit_handle('w', h);
      break;
    case INFO_DISPOSITION_EX:
      /* FILE_DISPOSITION_DELETE */
      if (length >= sizeof(ULONG) && (*(const ULONG *)info & 1)) emit_handle('w', h);
      break;
    default:
      break;
  }
}

static NTSTATUS NTAPI Hook_NtSetInformationFile(HANDLE h, PIO_STATUS_BLOCK io, PVOID info, ULONG length, ULONG cls) {
  /* The source's path is read before a rename changes it. */
  RECORD(set_information(h, info, length, cls));
  return Real_NtSetInformationFile(h, io, info, length, cls);
}

static NTSTATUS NTAPI Hook_NtDeleteFile(POBJECT_ATTRIBUTES oa) {
  NTSTATUS st = Real_NtDeleteFile(oa);
  RECORD(emit_attributes('w', oa));
  return st;
}

static NTSTATUS NTAPI Hook_NtFsControlFile(HANDLE h, HANDLE event, PIO_APC_ROUTINE apc, PVOID context,
                                           PIO_STATUS_BLOCK io, ULONG code, PVOID in, ULONG in_length, PVOID out,
                                           ULONG out_length) {
  if (code == FSCTL_GET_REPARSE) RECORD(emit_handle('r', h));
  else if (code == FSCTL_SET_REPARSE || code == FSCTL_DELETE_REPARSE) RECORD(emit_handle('w', h));
  return Real_NtFsControlFile(h, event, apc, context, io, code, in, in_length, out, out_length);
}

/* ---- processes ---------------------------------------------------------------------------------- */

static int name_is(const WCHAR *entry, const WCHAR *name) {
  size_t n = wcslen(name);
  return starts_with(entry, wcslen(entry), name) && entry[n] == L'=';
}

/*
 * The environment block for a new process: the given one (or this process's), with VEYRUM_TRACE
 * restored if the program removed it. A value that is present is kept: a traced process that
 * starts a capture of its own points it at another log on purpose. Returns NULL when the block
 * can be used as is; otherwise a Unicode block to free with HeapFree.
 */
static WCHAR *traced_environment(LPVOID given, DWORD flags) {
  WCHAR *converted = NULL;
  const WCHAR *block = (const WCHAR *)given;
  WCHAR *own = NULL;
  if (!given) {
    own = GetEnvironmentStringsW();
    block = own;
  } else if (!(flags & CREATE_UNICODE_ENVIRONMENT)) {
    const char *a = (const char *)given;
    size_t bytes = 0;
    while (a[bytes] || a[bytes + 1]) bytes++;
    bytes += 2;
    int n = MultiByteToWideChar(CP_ACP, 0, a, (int)bytes, NULL, 0);
    converted = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, (size_t)n * sizeof(WCHAR));
    if (!converted) return NULL;
    MultiByteToWideChar(CP_ACP, 0, a, (int)bytes, converted, n);
    block = converted;
  }
  if (!block) return NULL;
  size_t size = 0;
  int present = 0;
  for (const WCHAR *e = block; *e; e += wcslen(e) + 1) {
    if (name_is(e, L"VEYRUM_TRACE") && e[13]) present = 1;
  }
  const WCHAR *end = block;
  while (*end) end += wcslen(end) + 1;
  size = (size_t)(end - block);
  WCHAR *result = NULL;
  if (!present) {
    size_t value = wcslen(trace_value);
    result = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, (size + 13 + value + 2) * sizeof(WCHAR));
    if (result) {
      memcpy(result, block, size * sizeof(WCHAR));
      memcpy(result + size, L"VEYRUM_TRACE=", 13 * sizeof(WCHAR));
      memcpy(result + size + 13, trace_value, value * sizeof(WCHAR));
      result[size + 13 + value] = 0;
      result[size + 13 + value + 1] = 0;
    }
  } else if (converted) {
    result = converted;
    converted = NULL;
  }
  if (converted) HeapFree(GetProcessHeap(), 0, converted);
  if (own) FreeEnvironmentStringsW(own);
  return result;
}

/*
 * Every process creation meets here. The process is created suspended, gets this DLL in its import
 * table before its first instruction runs, and is resumed unless the caller wanted it suspended.
 */
static BOOL WINAPI Hook_CreateProcessInternalW(HANDLE token, LPCWSTR application, LPWSTR command_line,
                                               LPSECURITY_ATTRIBUTES process_attributes,
                                               LPSECURITY_ATTRIBUTES thread_attributes, BOOL inherit, DWORD flags,
                                               LPVOID environment, LPCWSTR directory, LPSTARTUPINFOW startup,
                                               LPPROCESS_INFORMATION info, PHANDLE new_token) {
  if (!tracing || busy)
    return Real_CreateProcessInternalW(token, application, command_line, process_attributes, thread_attributes, inherit,
                                       flags, environment, directory, startup, info, new_token);
  busy = 1;
  WCHAR *env = traced_environment(environment, flags);
  busy = 0;
  DWORD use_flags = flags | CREATE_SUSPENDED | (env ? CREATE_UNICODE_ENVIRONMENT : 0);
  creating++;
  BOOL ok = Real_CreateProcessInternalW(token, application, command_line, process_attributes, thread_attributes,
                                        inherit, use_flags, env ? env : environment, directory, startup, info,
                                        new_token);
  creating--;
  DWORD saved_error = GetLastError();
  if (ok) {
    busy = 1;
    SCRATCH *s = get_scratch();
    DWORD n = s ? MAX_NAME : 0;
    int image = s && QueryFullProcessImageNameW(info->hProcess, 0, s->base, &n);
    size_t len = 0;
    if (image) image = final_to_win32(s->base, n, s->path, MAX_NAME, &len) == PATH_FILE;
    LPCSTR dll = dll_path_ansi;
    /* A program this DLL cannot be loaded into (32-bit) runs untraced. */
    if (dll_path_ansi[0] && DetourUpdateProcessWithDll(info->hProcess, &dll, 1)) {
      if (image) emit_path('x', s->path, len);
      else emit_text('u', "unnamed program");
    } else if (image) {
      emit_path('u', s->path, len);
    } else {
      emit_text('u', "unnamed program");
    }
    busy = 0;
    if (!(flags & CREATE_SUSPENDED)) ResumeThread(info->hThread);
  }
  if (env) HeapFree(GetProcessHeap(), 0, env);
  SetLastError(saved_error);
  return ok;
}

/* Processes created without CreateProcessInternalW cannot get this DLL. */
static NTSTATUS NTAPI Hook_NtCreateUserProcess(PHANDLE process, PHANDLE thread, ACCESS_MASK process_access,
                                               ACCESS_MASK thread_access, POBJECT_ATTRIBUTES process_attributes,
                                               POBJECT_ATTRIBUTES thread_attributes, ULONG process_flags,
                                               ULONG thread_flags, PVOID parameters, PVOID create_info,
                                               PVOID attributes) {
  if (!creating) RECORD(emit_text('u', "NtCreateUserProcess"));
  return Real_NtCreateUserProcess(process, thread, process_access, thread_access, process_attributes,
                                  thread_attributes, process_flags, thread_flags, parameters, create_info, attributes);
}

static NTSTATUS NTAPI Hook_NtCreateProcessEx(PHANDLE process, ACCESS_MASK access, POBJECT_ATTRIBUTES oa, HANDLE parent,
                                             ULONG flags, HANDLE section, HANDLE debug, HANDLE token, ULONG reserved) {
  RECORD(emit_text('u', "NtCreateProcessEx"));
  return Real_NtCreateProcessEx(process, access, oa, parent, flags, section, debug, token, reserved);
}

static NTSTATUS NTAPI Hook_NtCreateProcess(PHANDLE process, ACCESS_MASK access, POBJECT_ATTRIBUTES oa, HANDLE parent,
                                           BOOLEAN inherit, HANDLE section, HANDLE debug, HANDLE token) {
  RECORD(emit_text('u', "NtCreateProcess"));
  return Real_NtCreateProcess(process, access, oa, parent, inherit, section, debug, token);
}

/* ---- network ------------------------------------------------------------------------------------ */

/* Records a connection attempt, successful or not: either way the outcome depends on the network. */
static void connecting(const struct sockaddr *addr, int len) {
  if (!addr || len < (int)sizeof(addr->sa_family)) return;
  char host[INET6_ADDRSTRLEN + 8];
  char line[400];
  if (addr->sa_family == AF_INET && len >= (int)sizeof(struct sockaddr_in)) {
    const struct sockaddr_in *in = (const struct sockaddr_in *)addr;
    if (!inet_ntop(AF_INET, &in->sin_addr, host, sizeof host)) return;
    snprintf(line, sizeof line, "%s %u", host, (unsigned)ntohs(in->sin_port));
  } else if (addr->sa_family == AF_INET6 && len >= (int)sizeof(struct sockaddr_in6)) {
    const struct sockaddr_in6 *in6 = (const struct sockaddr_in6 *)addr;
    if (!inet_ntop(AF_INET6, &in6->sin6_addr, host, sizeof host)) return;
    snprintf(line, sizeof line, "%s %u", host, (unsigned)ntohs(in6->sin6_port));
  } else if (addr->sa_family == AF_UNIX) {
    /* sockaddr_un: the family, then a path of up to 108 bytes. Treated like the test's own: local. */
    const char *path = (const char *)addr + sizeof(addr->sa_family);
    int max = len - (int)sizeof(addr->sa_family);
    if (max > 108) max = 108;
    int n = 0;
    while (n < max && path[n]) n++;
    if (n == 0) snprintf(line, sizeof line, "unix:abstract 0");
    else snprintf(line, sizeof line, "unix:%.*s 0", n, path);
  } else if (addr->sa_family == AF_UNSPEC) {
    /* Dissolves a datagram socket's association. */
    return;
  } else {
    snprintf(line, sizeof line, "af%u 0", (unsigned)addr->sa_family);
  }
  emit_text('n', line);
}

static int WSAAPI Hook_connect(SOCKET s, const struct sockaddr *addr, int len) {
  RECORD(connecting(addr, len));
  return Real_connect(s, addr, len);
}

static int WSAAPI Hook_WSAConnect(SOCKET s, const struct sockaddr *addr, int len, LPWSABUF caller, LPWSABUF callee,
                                  LPQOS sqos, LPQOS gqos) {
  RECORD(connecting(addr, len));
  return Real_WSAConnect(s, addr, len, caller, callee, sqos, gqos);
}

/* ConnectEx is handed out by WSAIoctl, one function per provider: each gets a wrapper of its own. */
#define CONNECT_EX_SLOTS 4
static ConnectEx_t volatile real_connect_ex[CONNECT_EX_SLOTS];
#define CONNECT_EX_WRAPPER(i)                                                                                   \
  static BOOL PASCAL ConnectEx##i(SOCKET s, const struct sockaddr *addr, int len, PVOID data, DWORD size,         \
                                  LPDWORD sent, LPOVERLAPPED overlapped) {                                        \
    RECORD(connecting(addr, len));                                                                              \
    return real_connect_ex[i](s, addr, len, data, size, sent, overlapped);                                      \
  }
CONNECT_EX_WRAPPER(0)
CONNECT_EX_WRAPPER(1)
CONNECT_EX_WRAPPER(2)
CONNECT_EX_WRAPPER(3)
static const ConnectEx_t connect_ex_wrappers[CONNECT_EX_SLOTS] = {ConnectEx0, ConnectEx1, ConnectEx2, ConnectEx3};

static int WSAAPI Hook_WSAIoctl(SOCKET s, DWORD code, LPVOID in, DWORD in_length, LPVOID out, DWORD out_length,
                                LPDWORD returned, LPWSAOVERLAPPED overlapped,
                                LPWSAOVERLAPPED_COMPLETION_ROUTINE completion) {
  int r = Real_WSAIoctl(s, code, in, in_length, out, out_length, returned, overlapped, completion);
  static const GUID connect_ex_id = WSAID_CONNECTEX;
  if (r == 0 && code == SIO_GET_EXTENSION_FUNCTION_POINTER && in && in_length >= sizeof(GUID) && out &&
      out_length >= sizeof(ConnectEx_t) && memcmp(in, &connect_ex_id, sizeof(GUID)) == 0) {
    ConnectEx_t real = *(ConnectEx_t *)out;
    for (int i = 0; i < CONNECT_EX_SLOTS && real; i++) {
      ConnectEx_t current = real_connect_ex[i];
      if (!current) {
        current = (ConnectEx_t)InterlockedCompareExchangePointer((PVOID volatile *)&real_connect_ex[i], (PVOID)real, NULL);
        if (!current) current = real;
      }
      if (current == real) {
        *(ConnectEx_t *)out = connect_ex_wrappers[i];
        return r;
      }
    }
    RECORD(emit_text('u', "ConnectEx"));
  }
  return r;
}

static void connecting_by_name(const char *host, unsigned port) {
  char line[400];
  snprintf(line, sizeof line, "%.300s %u", host && *host ? host : "localhost", port);
  emit_text('n', line);
}

static unsigned service_port(const WCHAR *service) {
  unsigned port = 0;
  for (const WCHAR *c = service; c && *c; c++) {
    if (*c < L'0' || *c > L'9') return 0;
    port = port * 10 + (unsigned)(*c - L'0');
  }
  return port;
}

static BOOL WSAAPI Hook_WSAConnectByNameW(SOCKET s, LPWSTR node, LPWSTR service, LPDWORD local_length,
                                          LPSOCKADDR local, LPDWORD remote_length, LPSOCKADDR remote,
                                          const struct timeval *timeout, LPWSAOVERLAPPED reserved) {
  RECORD({
    char host[300] = {0};
    if (node) WideCharToMultiByte(CP_UTF8, 0, node, -1, host, (int)sizeof host - 1, NULL, NULL);
    connecting_by_name(host, service_port(service));
  });
  return Real_WSAConnectByNameW(s, node, service, local_length, local, remote_length, remote, timeout, reserved);
}

static BOOL WSAAPI Hook_WSAConnectByNameA(SOCKET s, LPCSTR node, LPCSTR service, LPDWORD local_length,
                                          LPSOCKADDR local, LPDWORD remote_length, LPSOCKADDR remote,
                                          const struct timeval *timeout, LPWSAOVERLAPPED reserved) {
  RECORD({
    WCHAR wide[16] = {0};
    if (service) MultiByteToWideChar(CP_ACP, 0, service, -1, wide, 15);
    connecting_by_name(node, service_port(wide));
  });
  return Real_WSAConnectByNameA(s, node, service, local_length, local, remote_length, remote, timeout, reserved);
}

static BOOL WSAAPI Hook_WSAConnectByList(SOCKET s, PSOCKET_ADDRESS_LIST list, LPDWORD local_length, LPSOCKADDR local,
                                         LPDWORD remote_length, LPSOCKADDR remote, const struct timeval *timeout,
                                         LPWSAOVERLAPPED reserved) {
  RECORD({
    for (INT i = 0; list && i < list->iAddressCount; i++)
      connecting(list->Address[i].lpSockaddr, list->Address[i].iSockaddrLength);
  });
  return Real_WSAConnectByList(s, list, local_length, local, remote_length, remote, timeout, reserved);
}

/* ---- setup -------------------------------------------------------------------------------------- */

/* The DLL's path for import tables, which hold ANSI names: its short form when the long one does not fit. */
static void find_dll_path(void) {
  WCHAR wide[MAX_PATH * 2];
  DWORD n = GetModuleFileNameW(self_module, wide, MAX_PATH * 2);
  if (n == 0 || n >= MAX_PATH * 2) return;
  UINT code_page = GetACP();
  for (int attempt = 0; attempt < 2; attempt++) {
    BOOL lossy = FALSE;
    int k = code_page == CP_UTF8
                ? WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide, -1, dll_path_ansi, (int)sizeof dll_path_ansi,
                                      NULL, NULL)
                : WideCharToMultiByte(code_page, WC_NO_BEST_FIT_CHARS, wide, -1, dll_path_ansi,
                                      (int)sizeof dll_path_ansi, NULL, &lossy);
    if (k > 0 && !lossy) return;
    dll_path_ansi[0] = 0;
    if (attempt == 0) {
      WCHAR short_path[MAX_PATH * 2];
      DWORD s = GetShortPathNameW(wide, short_path, MAX_PATH * 2);
      if (s == 0 || s >= MAX_PATH * 2) return;
      memcpy(wide, short_path, (s + 1) * sizeof(WCHAR));
    }
  }
}

#define HOOK(module, name)                                                  \
  do {                                                                      \
    *(FARPROC *)&Real_##name = GetProcAddress(module, #name);               \
    if (Real_##name) DetourAttach((PVOID *)&Real_##name, (PVOID)Hook_##name); \
  } while (0)

static void start(void) {
  DWORD n = GetEnvironmentVariableW(L"VEYRUM_TRACE", trace_value, (DWORD)(sizeof trace_value / sizeof(WCHAR)));
  if (n == 0 || n >= sizeof trace_value / sizeof(WCHAR)) return;
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  HMODULE kernelbase = GetModuleHandleW(L"kernelbase.dll");
  /* Among this DLL's own imports (inet_ntop), so loaded before the program runs. */
  HMODULE ws2 = GetModuleHandleW(L"ws2_32.dll");
  if (!ntdll) return;
  *(FARPROC *)&Real_NtQueryInformationFile = GetProcAddress(ntdll, "NtQueryInformationFile");
  *(FARPROC *)&Real_NtQueryObject = GetProcAddress(ntdll, "NtQueryObject");
  *(FARPROC *)&Real_RtlAcquirePebLock = GetProcAddress(ntdll, "RtlAcquirePebLock");
  *(FARPROC *)&Real_RtlReleasePebLock = GetProcAddress(ntdll, "RtlReleasePebLock");
  if (!Real_NtQueryInformationFile) return;
  busy = 1;
  log_handle = log_open();
  find_dll_path();
  busy = 0;
  if (log_handle == INVALID_HANDLE_VALUE) return;

  DetourTransactionBegin();
  DetourUpdateThread(GetCurrentThread());
  HOOK(ntdll, NtCreateFile);
  HOOK(ntdll, NtOpenFile);
  HOOK(ntdll, NtQueryAttributesFile);
  HOOK(ntdll, NtQueryFullAttributesFile);
  HOOK(ntdll, NtQueryInformationByName);
  HOOK(ntdll, NtQueryDirectoryFile);
  HOOK(ntdll, NtQueryDirectoryFileEx);
  HOOK(ntdll, NtSetInformationFile);
  HOOK(ntdll, NtDeleteFile);
  HOOK(ntdll, NtFsControlFile);
  HOOK(ntdll, NtClose);
  HOOK(ntdll, NtCreateUserProcess);
  HOOK(ntdll, NtCreateProcessEx);
  HOOK(ntdll, NtCreateProcess);
  if (kernelbase) HOOK(kernelbase, CreateProcessInternalW);
  if (ws2) {
    HOOK(ws2, connect);
    HOOK(ws2, WSAConnect);
    HOOK(ws2, WSAIoctl);
    HOOK(ws2, WSAConnectByNameW);
    HOOK(ws2, WSAConnectByNameA);
    HOOK(ws2, WSAConnectByList);
  }
  LONG error = DetourTransactionCommit();
  if (error != NO_ERROR) {
    busy = 1;
    emit_text('u', "tracer could not start");
    busy = 0;
    return;
  }
  tracing = 1;
  /* Without its process hook, what this process starts would not be traced. */
  if (!Real_CreateProcessInternalW) {
    busy = 1;
    emit_text('u', "CreateProcessInternalW");
    busy = 0;
  }
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
  (void)reserved;
  if (DetourIsHelperProcess()) return TRUE;
  if (reason == DLL_PROCESS_ATTACH) {
    self_module = instance;
    DetourRestoreAfterWith();
    start();
  } else if (reason == DLL_THREAD_DETACH && scratch) {
    HeapFree(GetProcessHeap(), 0, scratch);
    scratch = NULL;
  }
  return TRUE;
}
