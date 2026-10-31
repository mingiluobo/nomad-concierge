import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

describe('starter page', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows that the starter services are connected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            status: 'ok',
            database: 'connected',
          }),
      }),
    );

    render(<App />);

    expect(
      screen.getByRole('heading', { name: 'Nomad Concierge' }),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        'API 与数据库已连接',
      );
    });
  });
});

