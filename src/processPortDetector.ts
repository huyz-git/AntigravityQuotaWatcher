/**
 * Process-based port detector.
 * Reads Antigravity Language Server command line args to extract ports and CSRF token.
 * Uses platform-specific strategies for cross-platform support.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as https from 'https';
import { PlatformDetector, IPlatformStrategy } from './platformDetector';

const execAsync = promisify(exec);

export interface AntigravityProcessInfo {
  /** HTTP port from --extension_server_port */
  extensionPort: number;
  /** HTTPS port for Connect/CommandModelConfigs (detected via testing) */
  connectPort: number;
  csrfToken: string;
}

export class ProcessPortDetector {
  private platformDetector: PlatformDetector;
  private platformStrategy: IPlatformStrategy;
  private processName: string;

  constructor() {
    this.platformDetector = new PlatformDetector();
    this.platformStrategy = this.platformDetector.getStrategy();
    this.processName = this.platformDetector.getProcessName();
  }

  /**
   * Detect credentials (ports + CSRF token) from the running process.
   * @param maxRetries Maximum number of retry attempts (default: 3)
   * @param retryDelay Delay between retries in milliseconds (default: 2000)
   */
  async detectProcessInfo(maxRetries: number = 3, retryDelay: number = 2000): Promise<AntigravityProcessInfo | null> {
    const platformName = this.platformDetector.getPlatformName();
    const errorMessages = this.platformStrategy.getErrorMessages();

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔍 尝试检测 Antigravity 进程 (${platformName}, 第 ${attempt}/${maxRetries} 次)...`);

        // Fetch full command line for the language server process using platform-specific command
        const command = this.platformStrategy.getProcessListCommand(this.processName);
        const { stdout } = await execAsync(command, { timeout: 5000 });

        // Parse process info using platform-specific parser
        const processInfo = this.platformStrategy.parseProcessInfo(stdout);

        if (!processInfo) {
          console.warn(`⚠️ 第 ${attempt} 次尝试: ${errorMessages.processNotFound}`);
          throw new Error(errorMessages.processNotFound);
        }

        const { pid, extensionPort, csrfToken } = processInfo;

        console.log(`✅ 找到进程信息:`);
        console.log(`   PID: ${pid}`);
        console.log(`   extension_server_port: ${extensionPort || '(未找到)'}`);
        console.log(`   CSRF Token: ${csrfToken.substring(0, 8)}...`);

        // 获取该进程监听的所有端口
        console.log(`🔍 正在获取 PID ${pid} 监听的端口...`);
        const listeningPorts = await this.getProcessListeningPorts(pid);

        if (listeningPorts.length === 0) {
          console.warn(`⚠️ 第 ${attempt} 次尝试: 进程未监听任何端口`);
          throw new Error('进程未监听任何端口');
        }

        console.log(`✅ 找到 ${listeningPorts.length} 个监听端口: ${listeningPorts.join(', ')}`);

        // 逐个测试端口，找到能响应 API 的端口
        console.log(`🔍 开始测试端口连接性...`);
        const connectPort = await this.findWorkingPort(listeningPorts, csrfToken);

        if (!connectPort) {
          console.warn(`⚠️ 第 ${attempt} 次尝试: 所有端口测试均失败`);
          throw new Error('无法找到可用的 API 端口');
        }

        console.log(`✅ 第 ${attempt} 次尝试成功!`);
        console.log(`✅ API 端口 (HTTPS): ${connectPort}`);

        return { extensionPort, connectPort, csrfToken };

      } catch (error: any) {
        const errorMsg = error?.message || String(error);
        console.error(`❌ 第 ${attempt} 次尝试失败:`, errorMsg);

        // 提供更具体的错误提示
        if (errorMsg.includes('timeout')) {
          console.error('   原因: 命令执行超时,系统可能负载较高');
        } else if (errorMsg.includes('not found') || errorMsg.includes('not recognized')) {
          console.error(`   原因: ${errorMessages.commandNotAvailable}`);
        }
      }

      // 如果还有重试机会,等待后重试
      if (attempt < maxRetries) {
        console.log(`⏳ 等待 ${retryDelay}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }

    console.error(`❌ 所有 ${maxRetries} 次尝试均失败`);
    console.error('   请确保:');
    errorMessages.requirements.forEach((req, index) => {
      console.error(`   ${index + 1}. ${req}`);
    });

    return null;
  }

  /**
   * 获取进程监听的所有端口
   */
  private async getProcessListeningPorts(pid: number): Promise<number[]> {
    try {
      const command = this.platformStrategy.getPortListCommand(pid);
      const { stdout } = await execAsync(command, { timeout: 3000 });

      // Parse ports using platform-specific parser
      const ports = this.platformStrategy.parseListeningPorts(stdout);
      return ports;
    } catch (error) {
      console.error('获取监听端口失败:', error);
      return [];
    }
  }

  /**
   * 测试端口列表，找到第一个能响应 API 的端口
   */
  private async findWorkingPort(ports: number[], csrfToken: string): Promise<number | null> {
    for (const port of ports) {
      console.log(`  🔍 测试端口 ${port}...`);
      const isWorking = await this.testPortConnectivity(port, csrfToken);
      if (isWorking) {
        console.log(`  ✅ 端口 ${port} 测试成功!`);
        return port;
      } else {
        console.log(`  ❌ 端口 ${port} 测试失败`);
      }
    }
    return null;
  }

  /**
   * 测试端口是否能响应 API 请求
   * 使用 GetUnleashData 端点，因为它不需要用户登录即可访问
   */
  private async testPortConnectivity(port: number, csrfToken: string): Promise<boolean> {
    return new Promise((resolve) => {
      const requestBody = JSON.stringify({
        context: {
          properties: {
            devMode: "false",
            extensionVersion: "",
            hasAnthropicModelAccess: "true",
            ide: "antigravity",
            ideVersion: "1.11.2",
            installationId: "test-detection",
            language: "UNSPECIFIED",
            os: "windows",
            requestedModelId: "MODEL_UNSPECIFIED"
          }
        }
      });

      const options = {
        hostname: '127.0.0.1',
        port: port,
        path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
          'Connect-Protocol-Version': '1',
          'X-Codeium-Csrf-Token': csrfToken
        },
        rejectUnauthorized: false,
        timeout: 2000
      };

      const req = https.request(options, (res) => {
        // 只要能连接并返回状态码，就认为是成功的
        const success = res.statusCode === 200;
        res.resume(); // 消费响应数据
        resolve(success);
      });

      req.on('error', () => {
        resolve(false);
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.write(requestBody);
      req.end();
    });
  }
}
