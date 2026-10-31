import { useEffect, useState } from 'react';

type ConnectionStatus = 'checking' | 'connected' | 'error';

type HealthResponse = {
  status: string;
  database: string;
};

export function App() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('checking');

  useEffect(() => {
    const controller = new AbortController();

    async function checkConnection() {
      try {
        const response = await fetch('/api/health', {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Health check failed with ${response.status}`);
        }

        const health = (await response.json()) as HealthResponse;
        setConnectionStatus(
          health.status === 'ok' && health.database === 'connected'
            ? 'connected'
            : 'error',
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        setConnectionStatus('error');
      }
    }

    void checkConnection();

    return () => controller.abort();
  }, []);

  const statusText = {
    checking: '正在检查 API 与数据库…',
    connected: 'API 与数据库已连接',
    error: '无法连接 API，请确认后端已启动',
  }[connectionStatus];

  return (
    <main className="shell">
      <section className="starter-card" aria-labelledby="page-title">
        <p className="eyebrow">FULL-STACK INTERVIEW STARTER</p>
        <h1 id="page-title">Nomad Concierge</h1>
        <p className="lede">
          工程底座已经就绪。请根据题面和澄清结果，在这里完成你的最小可用产品。
        </p>

        <div className={`status status--${connectionStatus}`} role="status">
          <span className="status__dot" aria-hidden="true" />
          {statusText}
        </div>

        <div className="next-step">
          <h2>起点，而不是答案</h2>
          <p>
            当前仓库只有健康检查和空白 SQLite
            数据库。业务模型、接口、Agent、页面与测试方案均由你设计。
          </p>
        </div>
      </section>
    </main>
  );
}

