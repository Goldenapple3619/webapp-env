/*
 * Builds the seccomp filter that every sandboxed job runs under (bubblewrap loads it right before exec'ing the job).
 *
 * The sandbox itself is made of namespaces, which is only as strong as the kernel surface a job can reach. So the filter is
 * a deny-list of what no compiler / interpreter / user program legitimately needs and what has a history of kernel bugs:
 *   - creating namespaces (the classic route from "unprivileged user" to "root in a user namespace" to kernel exploits)
 *   - mount-family, ptrace, bpf, perf, userfaultfd, io_uring, keyrings, kexec, module loading, clocks, reboot...
 * Everything else is allowed. clone3 answers ENOSYS (not EPERM) so glibc falls back to plain clone, which we inspect.
 * Names are resolved at run time, so the same source builds on x86_64 and aarch64 and skips what an arch does not have.
 *
 *   gcc -O2 -o seccomp_gen seccomp_gen.c -lseccomp && ./seccomp_gen out.bpf
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <seccomp.h>
#include <stdio.h>
#include <unistd.h>

static const char *DENY[] = {
    "ptrace", "process_vm_readv", "process_vm_writev", "kcmp",
    "mount", "umount", "umount2", "pivot_root", "chroot", "move_mount", "open_tree", "fsopen", "fsconfig", "fsmount",
    "fspick", "mount_setattr", "unshare", "setns",
    "bpf", "perf_event_open", "userfaultfd", "io_uring_setup", "io_uring_enter", "io_uring_register",
    "keyctl", "add_key", "request_key", "kexec_load", "kexec_file_load", "init_module", "finit_module", "delete_module",
    "reboot", "swapon", "swapoff", "acct", "quotactl", "quotactl_fd", "lookup_dcookie", "nfsservctl",
    "settimeofday", "clock_settime", "clock_adjtime", "adjtimex", "sethostname", "setdomainname", "iopl", "ioperm",
    "open_by_handle_at", "name_to_handle_at", "vhangup", "personality", "modify_ldt", "pciconfig_read", "pciconfig_write",
    "syslog", "_sysctl", "uselib", "ustat", "sysfs", "create_module", "get_kernel_syms", "query_module", "setfsuid", "setfsgid",
    NULL};

static const unsigned long NS_FLAGS[] = {CLONE_NEWUSER, CLONE_NEWNS, CLONE_NEWPID, CLONE_NEWNET, CLONE_NEWIPC,
                                         CLONE_NEWUTS, CLONE_NEWCGROUP, 0};

int main(int argc, char **argv) {
    if (argc != 2) { fprintf(stderr, "usage: %s out.bpf\n", argv[0]); return 2; }
    scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW);
    if (!ctx) return 1;
    for (int i = 0; DENY[i]; i++) {
        int nr = seccomp_syscall_resolve_name(DENY[i]);
        if (nr == __NR_SCMP_ERROR) continue;                       /* this architecture does not have it */
        if (seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), nr, 0) < 0) { fprintf(stderr, "rule %s failed\n", DENY[i]); return 1; }
    }
    int clone_nr = seccomp_syscall_resolve_name("clone");
    for (int i = 0; NS_FLAGS[i]; i++)                               /* clone(flags): any namespace flag set -> EPERM */
        if (seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), clone_nr, 1,
                             SCMP_A0(SCMP_CMP_MASKED_EQ, NS_FLAGS[i], NS_FLAGS[i])) < 0) return 1;
    int clone3_nr = seccomp_syscall_resolve_name("clone3");
    if (clone3_nr != __NR_SCMP_ERROR && seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), clone3_nr, 0) < 0) return 1;
    int fd = open(argv[1], O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) { perror("open"); return 1; }
    if (seccomp_export_bpf(ctx, fd) < 0) { fprintf(stderr, "export failed\n"); return 1; }
    close(fd);
    seccomp_release(ctx);
    return 0;
}
