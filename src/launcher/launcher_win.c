/*
 * launcher_win.c – Windows GUI-subsystem launcher for node-gui packed apps.
 *
 * Compiled with /SUBSYSTEM:WINDOWS so no console window appears when the user
 * double-clicks the packaged .exe.  The launcher:
 *   1. Opens itself and reads the PackFooter from the last FOOTER_SIZE bytes.
 *   2. Verifies the "NGPACK01" magic.
 *   3. Extracts the embedded files to a temporary directory.
 *   4. Spawns  node.exe <tempdir>\<main_path>  using CreateProcess.
 *   5. Waits for node.exe to exit, cleans up the temp dir, then returns the
 *      same exit code.
 *
 * Build (MSVC, from a Developer Command Prompt):
 *   cl /nologo /O2 /W3 launcher_win.c /link /SUBSYSTEM:WINDOWS user32.lib
 *
 * Build (MinGW-w64):
 *   x86_64-w64-mingw32-gcc -O2 -o launcher.exe launcher_win.c -mwindows -luser32
 */

#define WIN32_LEAN_AND_MEAN
#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

/* -------------------------------------------------------------------------
 * Pack format
 * -------------------------------------------------------------------------
 * The executable file is laid out as:
 *
 *   [ launcher binary ]
 *   [ file entries    ]  <-- starts at footer.archive_offset
 *   [ PackFooter      ]  <-- last FOOTER_SIZE bytes
 *
 * Each file entry:
 *   uint32_t path_len         (little-endian)
 *   char     path[path_len]   (UTF-8, forward-slash separators)
 *   uint64_t data_len         (little-endian)
 *   uint8_t  data[data_len]
 *
 * PackFooter (FOOTER_SIZE bytes, little-endian multi-byte fields):
 *   uint32_t file_count
 *   uint32_t flags            (FLAG_HIDE_CONSOLE = 1)
 *   uint64_t archive_offset
 *   char     main_path[128]   (null-terminated UTF-8)
 *   char     magic[8]         ("NGPACK01")
 */

#define MAGIC          "NGPACK01"
#define MAGIC_LEN      8
#define MAIN_PATH_MAX  128
#define FOOTER_SIZE    (4 + 4 + 8 + MAIN_PATH_MAX + MAGIC_LEN)  /* 152 */
#define FLAG_HIDE_CONSOLE 0x01

#pragma pack(push, 1)
typedef struct {
    uint32_t file_count;
    uint32_t flags;
    uint64_t archive_offset;
    char     main_path[MAIN_PATH_MAX];
    char     magic[MAGIC_LEN];
} PackFooter;
#pragma pack(pop)

/* -------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------*/

static void show_error(const wchar_t* msg)
{
    MessageBoxW(NULL, msg, L"node-gui launcher", MB_ICONERROR | MB_OK);
}

/* Read exactly `len` bytes from `hFile` into `buf`. */
static BOOL read_exact(HANDLE hFile, void* buf, DWORD len)
{
    DWORD got = 0;
    return ReadFile(hFile, buf, len, &got, NULL) && got == len;
}

/* Seek `hFile` to an absolute offset from the beginning of the file. */
static BOOL seek_abs(HANDLE hFile, UINT64 offset)
{
    LARGE_INTEGER li;
    li.QuadPart = (LONGLONG)offset;
    return SetFilePointerEx(hFile, li, NULL, FILE_BEGIN);
}

/* Create all intermediate directories for `path` (modifies `path` in place
 * temporarily, then restores it). */
static void make_dirs(wchar_t* path)
{
    for (wchar_t* p = path + 1; *p; p++) {
        if (*p == L'\\') {
            *p = L'\0';
            CreateDirectoryW(path, NULL);
            *p = L'\\';
        }
    }
}

/* Recursively delete a directory tree. */
static void delete_tree(const wchar_t* dir)
{
    wchar_t pattern[MAX_PATH];
    WIN32_FIND_DATAW fd;
    HANDLE hFind;

    if (wcslen(dir) + 3 >= MAX_PATH) return;
    swprintf_s(pattern, MAX_PATH, L"%s\\*", dir);

    hFind = FindFirstFileW(pattern, &fd);
    if (hFind == INVALID_HANDLE_VALUE) {
        RemoveDirectoryW(dir);
        return;
    }
    do {
        wchar_t child[MAX_PATH];
        if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0)
            continue;
        swprintf_s(child, MAX_PATH, L"%s\\%s", dir, fd.cFileName);
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
            delete_tree(child);
        else
            DeleteFileW(child);
    } while (FindNextFileW(hFind, &fd));
    FindClose(hFind);
    RemoveDirectoryW(dir);
}

/* UTF-8 → UTF-16 (caller must free the returned pointer). */
static wchar_t* utf8_to_wide(const char* s, int len_bytes)
{
    int n = MultiByteToWideChar(CP_UTF8, 0, s, len_bytes, NULL, 0);
    if (n <= 0) return NULL;
    wchar_t* w = (wchar_t*)malloc((n + 1) * sizeof(wchar_t));
    if (!w) return NULL;
    MultiByteToWideChar(CP_UTF8, 0, s, len_bytes, w, n);
    w[n] = L'\0';
    /* normalise separators */
    for (wchar_t* p = w; *p; p++)
        if (*p == L'/') *p = L'\\';
    return w;
}

/* -------------------------------------------------------------------------
 * Extract the embedded archive to `extract_dir`.
 * -------------------------------------------------------------------------*/
static BOOL extract_archive(HANDLE hFile, const PackFooter* footer,
                             const wchar_t* extract_dir)
{
    uint32_t i;
    if (!seek_abs(hFile, footer->archive_offset)) return FALSE;

    for (i = 0; i < footer->file_count; i++) {
        uint32_t path_len = 0;
        uint64_t data_len = 0;
        char*    path_utf8;
        wchar_t* path_wide;
        wchar_t  full_path[MAX_PATH];
        HANDLE   hOut;
        uint64_t remaining;

        if (!read_exact(hFile, &path_len, 4)) return FALSE;
        if (path_len == 0 || path_len > 4096) return FALSE;

        path_utf8 = (char*)malloc(path_len + 1);
        if (!path_utf8) return FALSE;
        if (!read_exact(hFile, path_utf8, path_len)) { free(path_utf8); return FALSE; }
        path_utf8[path_len] = '\0';

        if (!read_exact(hFile, &data_len, 8)) { free(path_utf8); return FALSE; }

        path_wide = utf8_to_wide(path_utf8, (int)path_len);
        free(path_utf8);
        if (!path_wide) {
            /* skip data */
            LARGE_INTEGER skip; skip.QuadPart = (LONGLONG)data_len;
            SetFilePointerEx(hFile, skip, NULL, FILE_CURRENT);
            continue;
        }

        swprintf_s(full_path, MAX_PATH, L"%s\\%s", extract_dir, path_wide);
        free(path_wide);

        /* Create parent directories */
        make_dirs(full_path);

        hOut = CreateFileW(full_path, GENERIC_WRITE, 0, NULL,
                           CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
        if (hOut == INVALID_HANDLE_VALUE) {
            LARGE_INTEGER skip; skip.QuadPart = (LONGLONG)data_len;
            SetFilePointerEx(hFile, skip, NULL, FILE_CURRENT);
            continue;
        }

        remaining = data_len;
        {
            char buf[65536];
            while (remaining > 0) {
                DWORD to_read = (DWORD)(remaining < sizeof(buf) ? remaining : sizeof(buf));
                DWORD bytes_read = 0, written = 0;
                if (!ReadFile(hFile, buf, to_read, &bytes_read, NULL) || bytes_read == 0) break;
                WriteFile(hOut, buf, bytes_read, &written, NULL);
                remaining -= bytes_read;
            }
        }
        CloseHandle(hOut);
    }
    return TRUE;
}

/* -------------------------------------------------------------------------
 * Entry point
 * -------------------------------------------------------------------------*/
int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE hPrev,
                   LPSTR lpCmdLine, int nShowCmd)
{
    wchar_t  exe_path[MAX_PATH];
    HANDLE   hFile;
    UINT64   file_size;
    PackFooter footer;
    wchar_t  temp_base[MAX_PATH];
    wchar_t  extract_dir[MAX_PATH];
    wchar_t* main_wide;
    wchar_t  cmdline[32768];
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    DWORD    create_flags;
    DWORD    exit_code = 1;

    (void)hInstance; (void)hPrev; (void)lpCmdLine; (void)nShowCmd;

    /* --- locate ourselves ------------------------------------------------ */
    if (!GetModuleFileNameW(NULL, exe_path, MAX_PATH)) {
        show_error(L"Failed to determine executable path.");
        return 1;
    }

    hFile = CreateFileW(exe_path, GENERIC_READ, FILE_SHARE_READ,
                        NULL, OPEN_EXISTING, 0, NULL);
    if (hFile == INVALID_HANDLE_VALUE) {
        show_error(L"Failed to open executable for reading.");
        return 1;
    }

    /* --- get file size --------------------------------------------------- */
    {
        LARGE_INTEGER sz;
        if (!GetFileSizeEx(hFile, &sz)) {
            show_error(L"Failed to query executable size.");
            CloseHandle(hFile);
            return 1;
        }
        file_size = (UINT64)sz.QuadPart;
    }

    if (file_size < (UINT64)FOOTER_SIZE) {
        show_error(L"Executable does not contain pack data.");
        CloseHandle(hFile);
        return 1;
    }

    /* --- read footer ----------------------------------------------------- */
    if (!seek_abs(hFile, file_size - FOOTER_SIZE)) {
        show_error(L"Failed to seek to footer.");
        CloseHandle(hFile);
        return 1;
    }
    if (!read_exact(hFile, &footer, FOOTER_SIZE)) {
        show_error(L"Failed to read footer.");
        CloseHandle(hFile);
        return 1;
    }
    if (memcmp(footer.magic, MAGIC, MAGIC_LEN) != 0) {
        show_error(L"No embedded pack data found.\n"
                   L"This executable was not packaged with node-gui-pack.");
        CloseHandle(hFile);
        return 1;
    }

    /* --- create temp extraction directory -------------------------------- */
    GetTempPathW(MAX_PATH, temp_base);
    swprintf_s(extract_dir, MAX_PATH, L"%sngpack_%u",
               temp_base, GetCurrentProcessId());
    if (!CreateDirectoryW(extract_dir, NULL)) {
        show_error(L"Failed to create temporary directory.");
        CloseHandle(hFile);
        return 1;
    }

    /* --- extract files --------------------------------------------------- */
    if (!extract_archive(hFile, &footer, extract_dir)) {
        show_error(L"Failed to extract embedded files.");
        CloseHandle(hFile);
        delete_tree(extract_dir);
        return 1;
    }
    CloseHandle(hFile);

    /* --- build node command line ----------------------------------------- */
    footer.main_path[MAIN_PATH_MAX - 1] = '\0';
    main_wide = utf8_to_wide(footer.main_path, -1);
    if (!main_wide) {
        show_error(L"Invalid main entry path in pack data.");
        delete_tree(extract_dir);
        return 1;
    }

    swprintf_s(cmdline, 32768, L"node \"%s\\%s\"", extract_dir, main_wide);
    free(main_wide);

    /* --- spawn node ------------------------------------------------------- */
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));

    create_flags = 0;
    if (footer.flags & FLAG_HIDE_CONSOLE)
        create_flags = CREATE_NO_WINDOW;

    if (!CreateProcessW(NULL, cmdline, NULL, NULL, FALSE,
                        create_flags, NULL, extract_dir, &si, &pi)) {
        DWORD err = GetLastError();
        wchar_t msg[512];
        swprintf_s(msg, 512,
            L"Failed to start node.exe (error %lu).\n"
            L"Make sure Node.js is installed and available in PATH.", err);
        show_error(msg);
        delete_tree(extract_dir);
        return 1;
    }

    WaitForSingleObject(pi.hProcess, INFINITE);
    GetExitCodeProcess(pi.hProcess, &exit_code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);

    /* --- cleanup --------------------------------------------------------- */
    delete_tree(extract_dir);

    return (int)exit_code;
}
