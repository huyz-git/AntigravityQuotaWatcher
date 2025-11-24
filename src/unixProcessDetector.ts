/**
 * Unix-based (macOS/Linux) process detection implementation.
 * Uses ps and lsof/netstat commands.
 */

import { IPlatformStrategy } from './platformDetector';

export class UnixProcessDetector implements IPlatformStrategy {
    private platform: NodeJS.Platform;

    constructor(platform: NodeJS.Platform) {
        this.platform = platform;
    }

    /**
     * Get command to list Unix processes using ps and grep.
     */
    getProcessListCommand(processName: string): string {
        // Use ps aux to get full command line, grep for the process, exclude grep itself
        return `ps aux | grep "${processName}" | grep -v grep`;
    }

    /**
     * Parse ps output to extract process information.
     * Expected format:
     *   user  1234  0.0  0.0  ...  /path/to/language_server --extension_server_port=1234 --csrf_token=abc123
     */
    parseProcessInfo(stdout: string): {
        pid: number;
        extensionPort: number;
        csrfToken: string;
    } | null {
        if (!stdout || stdout.trim().length === 0) {
            return null;
        }

        // Extract command line arguments from ps output
        const portMatch = stdout.match(/--extension_server_port[=\s]+(\d+)/);
        const tokenMatch = stdout.match(/--csrf_token[=\s]+([a-f0-9\-]+)/i);

        // Parse PID from ps output (second column)
        // Format: user PID %CPU %MEM ...
        const lines = stdout.trim().split('\n');
        if (lines.length === 0) {
            return null;
        }

        // Take the first matching line
        const firstLine = lines[0];
        const columns = firstLine.trim().split(/\s+/);

        if (columns.length < 2) {
            return null;
        }

        const pidStr = columns[1];
        const pid = parseInt(pidStr, 10);

        if (isNaN(pid)) {
            return null;
        }

        if (!tokenMatch || !tokenMatch[1]) {
            return null;
        }

        const extensionPort = portMatch && portMatch[1] ? parseInt(portMatch[1], 10) : 0;
        const csrfToken = tokenMatch[1];

        return { pid, extensionPort, csrfToken };
    }

    /**
     * Get command to list ports for a specific process.
     * Tries lsof first (more reliable), falls back to netstat.
     */
    getPortListCommand(pid: number): string {
        // lsof is more reliable and available on both macOS and Linux
        // -P: no port name resolution
        // -a: AND the conditions
        // -n: no hostname resolution
        // -p: process ID
        // -i: internet connections only
        return `lsof -Pan -p ${pid} -i 2>/dev/null || netstat -tulpn 2>/dev/null | grep ${pid}`;
    }

    /**
     * Parse lsof/netstat output to extract listening ports.
     * 
     * lsof format:
     *   language_ 1234 user  10u  IPv4 0x... 0t0  TCP 127.0.0.1:2873 (LISTEN)
     * 
     * netstat format (Linux):
     *   tcp  0  0  127.0.0.1:2873  0.0.0.0:*  LISTEN  1234/language_server
     */
    parseListeningPorts(stdout: string): number[] {
        const ports: number[] = [];

        if (!stdout || stdout.trim().length === 0) {
            return ports;
        }

        const lines = stdout.trim().split('\n');

        for (const line of lines) {
            // Try lsof format first: look for 127.0.0.1:PORT (LISTEN)
            const lsofMatch = line.match(/127\.0\.0\.1:(\d+).*\(LISTEN\)/);
            if (lsofMatch && lsofMatch[1]) {
                const port = parseInt(lsofMatch[1], 10);
                if (!ports.includes(port)) {
                    ports.push(port);
                }
                continue;
            }

            // Try netstat format: 127.0.0.1:PORT ... LISTEN
            const netstatMatch = line.match(/127\.0\.0\.1:(\d+).*LISTEN/);
            if (netstatMatch && netstatMatch[1]) {
                const port = parseInt(netstatMatch[1], 10);
                if (!ports.includes(port)) {
                    ports.push(port);
                }
                continue;
            }

            // Also try localhost format
            const localhostMatch = line.match(/localhost:(\d+).*\(LISTEN\)|localhost:(\d+).*LISTEN/);
            if (localhostMatch) {
                const port = parseInt(localhostMatch[1] || localhostMatch[2], 10);
                if (!ports.includes(port)) {
                    ports.push(port);
                }
            }
        }

        return ports.sort((a, b) => a - b);
    }

    /**
     * Get Unix-specific error messages.
     */
    getErrorMessages(): {
        processNotFound: string;
        commandNotAvailable: string;
        requirements: string[];
    } {
        const processName = this.platform === 'darwin'
            ? 'language_server_macos'
            : 'language_server_linux';

        return {
            processNotFound: '未找到 language_server 进程',
            commandNotAvailable: 'ps/lsof 命令不可用,请检查系统环境',
            requirements: [
                'Antigravity 正在运行',
                `${processName} 进程存在`,
                '系统有足够权限执行 ps 和 lsof 命令'
            ]
        };
    }
}
