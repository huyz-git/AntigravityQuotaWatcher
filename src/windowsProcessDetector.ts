/**
 * Windows-specific process detection implementation.
 * Uses wmic and netstat commands.
 */

import { IPlatformStrategy } from './platformDetector';

export class WindowsProcessDetector implements IPlatformStrategy {
    /**
     * Get command to list Windows processes using wmic.
     */
    getProcessListCommand(processName: string): string {
        return `wmic process where "name='${processName}'" get ProcessId,CommandLine /format:list`;
    }

    /**
     * Parse wmic output to extract process information.
     * Expected format:
     *   CommandLine=...--extension_server_port=1234 --csrf_token=abc123...
     *   ProcessId=5678
     */
    parseProcessInfo(stdout: string): {
        pid: number;
        extensionPort: number;
        csrfToken: string;
    } | null {
        const portMatch = stdout.match(/--extension_server_port[=\s]+(\d+)/);
        const tokenMatch = stdout.match(/--csrf_token[=\s]+([a-f0-9\-]+)/i);
        const pidMatch = stdout.match(/ProcessId=(\d+)/);

        if (!pidMatch || !pidMatch[1]) {
            return null;
        }

        if (!tokenMatch || !tokenMatch[1]) {
            return null;
        }

        const pid = parseInt(pidMatch[1], 10);
        const extensionPort = portMatch && portMatch[1] ? parseInt(portMatch[1], 10) : 0;
        const csrfToken = tokenMatch[1];

        return { pid, extensionPort, csrfToken };
    }

    /**
     * Get command to list ports for a specific process using netstat.
     */
    getPortListCommand(pid: number): string {
        return `netstat -ano | findstr "${pid}" | findstr "LISTENING"`;
    }

    /**
     * Parse netstat output to extract listening ports.
     * Expected format:
     *   TCP    127.0.0.1:2873         0.0.0.0:0              LISTENING       4412
     */
    parseListeningPorts(stdout: string): number[] {
        const portRegex = /127\.0\.0\.1:(\d+)\s+0\.0\.0\.0:0\s+LISTENING/g;
        const ports: number[] = [];
        let match;

        while ((match = portRegex.exec(stdout)) !== null) {
            const port = parseInt(match[1], 10);
            if (!ports.includes(port)) {
                ports.push(port);
            }
        }

        return ports.sort((a, b) => a - b);
    }

    /**
     * Get Windows-specific error messages.
     */
    getErrorMessages(): {
        processNotFound: string;
        commandNotAvailable: string;
        requirements: string[];
    } {
        return {
            processNotFound: '未找到 language_server 进程',
            commandNotAvailable: 'wmic 命令不可用,请检查系统环境',
            requirements: [
                'Antigravity 正在运行',
                'language_server_windows_x64.exe 进程存在',
                '系统有足够权限执行 wmic 和 netstat 命令'
            ]
        };
    }
}
