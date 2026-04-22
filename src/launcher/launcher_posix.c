/*
 * launcher_posix.c – POSIX launcher for node-gui packed apps.
 *
 * Works on Linux and macOS.  The launcher:
 *   1. Opens itself and reads the PackFooter from the last FOOTER_SIZE bytes.
 *   2. Verifies the "NGPACK01" magic.
 *   3. Extracts the embedded files to a temporary directory.
 *   4. fork()s and exec()s  node <tmpdir>/<main_path>.
 *   5. Waits for node to exit, cleans up the temp dir, then returns the
 *      same exit code.
 *
 * Build (Linux / macOS):
 *   cc -O2 -o launcher launcher_posix.c
 */

#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <dirent.h>
#include <limits.h>

#if defined(__APPLE__)
#  include <mach-o/dyld.h>
#endif

/* -------------------------------------------------------------------------
 * Pack format  (same as launcher_win.c – keep in sync)
 * -------------------------------------------------------------------------
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
 * PackFooter:
 *   uint32_t file_count
 *   uint32_t flags            (FLAG_HIDE_CONSOLE = 1, ignored on POSIX)
 *   uint64_t archive_offset
 *   char     main_path[128]   (null-terminated UTF-8)
 *   char     magic[8]         ("NGPACK01")
 */

#define MAGIC         "NGPACK01"
#define MAGIC_LEN     8
#define MAIN_PATH_MAX 128
#define FOOTER_SIZE   (4 + 4 + 8 + MAIN_PATH_MAX + MAGIC_LEN)  /* 152 */

/* LE uint32 / uint64 readers (portable, avoids alignment issues) */
static uint32_t read_u32le(const unsigned char* p)
{
    return (uint32_t)p[0]
         | ((uint32_t)p[1] << 8)
         | ((uint32_t)p[2] << 16)
         | ((uint32_t)p[3] << 24);
}

static uint64_t read_u64le(const unsigned char* p)
{
    return (uint64_t)p[0]
         | ((uint64_t)p[1] << 8)
         | ((uint64_t)p[2] << 16)
         | ((uint64_t)p[3] << 24)
         | ((uint64_t)p[4] << 32)
         | ((uint64_t)p[5] << 40)
         | ((uint64_t)p[6] << 48)
         | ((uint64_t)p[7] << 56);
}

typedef struct {
    uint32_t file_count;
    uint32_t flags;
    uint64_t archive_offset;
    char     main_path[MAIN_PATH_MAX];
} PackFooter;

/* -------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------*/

static int read_exact(int fd, void* buf, size_t len)
{
    size_t done = 0;
    while (done < len) {
        ssize_t n = read(fd, (char*)buf + done, len - done);
        if (n <= 0) return -1;
        done += (size_t)n;
    }
    return 0;
}

/* Create parent directories for a file path (modifies path temporarily). */
static void make_dirs(char* path)
{
    for (char* p = path + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            mkdir(path, 0755);
            *p = '/';
        }
    }
}

/* Recursively delete a directory tree. */
static void delete_tree(const char* dir)
{
    DIR* d = opendir(dir);
    if (!d) { remove(dir); return; }

    struct dirent* de;
    while ((de = readdir(d)) != NULL) {
        if (strcmp(de->d_name, ".") == 0 || strcmp(de->d_name, "..") == 0)
            continue;

        char child[PATH_MAX];
        snprintf(child, sizeof(child), "%s/%s", dir, de->d_name);

        struct stat st;
        if (lstat(child, &st) == 0 && S_ISDIR(st.st_mode))
            delete_tree(child);
        else
            remove(child);
    }
    closedir(d);
    rmdir(dir);
}

/* Find the path of the running executable. */
static int get_exe_path(char* buf, size_t size)
{
#if defined(__linux__)
    ssize_t n = readlink("/proc/self/exe", buf, size - 1);
    if (n < 0) return -1;
    buf[n] = '\0';
    return 0;
#elif defined(__APPLE__)
    {
        uint32_t sz = (uint32_t)size;
        if (_NSGetExecutablePath(buf, &sz) != 0) return -1;
        return 0;
    }
#else
    (void)buf; (void)size;
    return -1;
#endif
}

/* -------------------------------------------------------------------------
 * Extract the embedded archive to `extract_dir`.
 * -------------------------------------------------------------------------*/
static int extract_archive(int fd, const PackFooter* footer,
                            const char* extract_dir)
{
    if (lseek(fd, (off_t)footer->archive_offset, SEEK_SET) < 0) return -1;

    for (uint32_t i = 0; i < footer->file_count; i++) {
        unsigned char hdr[4];
        uint32_t path_len;
        uint64_t data_len;
        char*    path;
        char     full_path[PATH_MAX];
        int      out_fd;
        uint64_t remaining;

        if (read_exact(fd, hdr, 4) < 0) return -1;
        path_len = read_u32le(hdr);
        if (path_len == 0 || path_len > 4096) return -1;

        path = (char*)malloc(path_len + 1);
        if (!path) return -1;
        if (read_exact(fd, path, path_len) < 0) { free(path); return -1; }
        path[path_len] = '\0';

        unsigned char len8[8];
        if (read_exact(fd, len8, 8) < 0) { free(path); return -1; }
        data_len = read_u64le(len8);

        snprintf(full_path, sizeof(full_path), "%s/%s", extract_dir, path);
        free(path);

        /* create parent directories */
        make_dirs(full_path);

        out_fd = open(full_path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (out_fd < 0) {
            /* skip the data for this entry */
            if (lseek(fd, (off_t)data_len, SEEK_CUR) < 0) return -1;
            continue;
        }

        remaining = data_len;
        {
            char buf[65536];
            while (remaining > 0) {
                size_t  to_read = remaining < sizeof(buf) ? (size_t)remaining : sizeof(buf);
                ssize_t nr = read(fd, buf, to_read);
                if (nr <= 0) { close(out_fd); return -1; }
                if (write(out_fd, buf, (size_t)nr) != nr) { close(out_fd); return -1; }
                remaining -= (uint64_t)nr;
            }
        }
        close(out_fd);
    }
    return 0;
}

/* -------------------------------------------------------------------------
 * Entry point
 * -------------------------------------------------------------------------*/
int main(int argc, char* argv[])
{
    char      exe_path[PATH_MAX];
    int       fd;
    off_t     file_size;
    unsigned char footer_raw[FOOTER_SIZE];
    PackFooter footer;
    char      extract_dir[PATH_MAX];
    char      main_path_full[PATH_MAX];
    pid_t     pid;
    int       status = 0;

    (void)argc; (void)argv;

    /* --- locate ourselves ------------------------------------------------ */
    if (get_exe_path(exe_path, sizeof(exe_path)) < 0) {
        fprintf(stderr, "node-gui launcher: cannot determine executable path\n");
        return 1;
    }

    fd = open(exe_path, O_RDONLY);
    if (fd < 0) {
        fprintf(stderr, "node-gui launcher: cannot open %s: %s\n",
                exe_path, strerror(errno));
        return 1;
    }

    /* --- get file size --------------------------------------------------- */
    file_size = lseek(fd, 0, SEEK_END);
    if (file_size < (off_t)FOOTER_SIZE) {
        fprintf(stderr, "node-gui launcher: executable too small to contain pack data\n");
        close(fd);
        return 1;
    }

    /* --- read footer ----------------------------------------------------- */
    if (lseek(fd, file_size - (off_t)FOOTER_SIZE, SEEK_SET) < 0
            || read_exact(fd, footer_raw, FOOTER_SIZE) < 0) {
        fprintf(stderr, "node-gui launcher: cannot read footer\n");
        close(fd);
        return 1;
    }

    if (memcmp(footer_raw + FOOTER_SIZE - MAGIC_LEN, MAGIC, MAGIC_LEN) != 0) {
        fprintf(stderr, "node-gui launcher: no embedded pack data found\n"
                        "(was this built with node-gui-pack?)\n");
        close(fd);
        return 1;
    }

    footer.file_count      = read_u32le(footer_raw);
    footer.flags           = read_u32le(footer_raw + 4);
    footer.archive_offset  = read_u64le(footer_raw + 8);
    memcpy(footer.main_path, footer_raw + 16, MAIN_PATH_MAX);
    footer.main_path[MAIN_PATH_MAX - 1] = '\0';

    /* --- create temp extraction directory -------------------------------- */
    snprintf(extract_dir, sizeof(extract_dir), "/tmp/ngpack_%d", (int)getpid());
    if (mkdir(extract_dir, 0700) < 0) {
        fprintf(stderr, "node-gui launcher: cannot create temp dir %s: %s\n",
                extract_dir, strerror(errno));
        close(fd);
        return 1;
    }

    /* --- extract files --------------------------------------------------- */
    if (extract_archive(fd, &footer, extract_dir) < 0) {
        fprintf(stderr, "node-gui launcher: extraction failed\n");
        close(fd);
        delete_tree(extract_dir);
        return 1;
    }
    close(fd);

    /* --- spawn node ------------------------------------------------------- */
    snprintf(main_path_full, sizeof(main_path_full), "%s/%s",
             extract_dir, footer.main_path);

    pid = fork();
    if (pid < 0) {
        fprintf(stderr, "node-gui launcher: fork failed: %s\n", strerror(errno));
        delete_tree(extract_dir);
        return 1;
    }

    if (pid == 0) {
        /* child: exec node */
        char* args[] = { "node", main_path_full, NULL };
        execvp("node", args);
        
        /* exec failed – display user-friendly error message */
        fprintf(stderr,
            "\n"
            "╔════════════════════════════════════════════════════════════════╗\n"
            "║  Node.js is not installed or not available in PATH            ║\n"
            "╚════════════════════════════════════════════════════════════════╝\n"
            "\n"
            "To run this application, please:\n"
            "  1. Install Node.js from https://nodejs.org\n"
            "  2. Ensure 'node' is available in your system PATH\n"
            "  3. Restart this application\n"
            "\n"
            "Technical details: %s\n"
            "\n", strerror(errno));
        exit(127);
    }

    /* parent: wait for child */
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR)
        ;

    /* --- cleanup --------------------------------------------------------- */
    delete_tree(extract_dir);

    if (WIFEXITED(status)) {
        int exit_code = WEXITSTATUS(status);
        // Exit code 127 indicates exec failed (usually command not found)
        if (exit_code == 127) {
            fprintf(stderr,
                "\n"
                "╔════════════════════════════════════════════════════════════════╗\n"
                "║  Application error: Node.js could not be found                ║\n"
                "╚════════════════════════════════════════════════════════════════╝\n"
                "\n");
            return 1;
        }
        return exit_code;
    }

    return 1;
}
