import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { desktopCommands } from '../runtime/tauri';
import { start } from './boot';

vi.mock('../runtime/tauri', () => ({ desktopCommands: { appInfo: vi.fn(), desktopConfig: vi.fn() } }));
vi.mock('../api/client', () => ({ apiClient: { configure: vi.fn() } }));
vi.mock('../auth/login', () => ({ installStepUpHandler: vi.fn() }));
vi.mock('../runtime/apiTransport', () => ({ nativeApiFetch: vi.fn() }));
vi.mock('../runtime/secretTokenStore', () => ({ SecretTokenStore: class {} }));
vi.mock('./DesktopApp', () => ({ default: () => <div>Desktop ready</div> }));

beforeEach(() => vi.resetAllMocks());

it('shows an embedded deployment error before attempting any server request', async () => {
  vi.mocked(desktopCommands.appInfo).mockResolvedValue({
    configError: 'endpoint must use https (http allowed only for loopback)',
  });
  const { App } = await start();
  render(<App />);
  expect(screen.getByRole('alert')).toHaveTextContent('E_DESKTOP_BOOTSTRAP');
  expect(screen.getByRole('alert')).toHaveTextContent('endpoint must use https');
  expect(screen.queryByText(/File cấu hình:/)).not.toBeInTheDocument();
  expect(desktopCommands.desktopConfig).not.toHaveBeenCalled();
});

it('preserves native network details, the actual API address and request ID', async () => {
  vi.mocked(desktopCommands.appInfo).mockResolvedValue({ apiBaseUrl: 'http://10.23.5.40:8080/c/', logDir: 'C:\\logs' });
  vi.mocked(desktopCommands.desktopConfig).mockRejectedValue({
    code: 'E_CONFIG_NETWORK', message: 'handshake connect: connection refused',
    details: { stage: 'handshake', requestId: 'desktop-test123' },
  });
  const { App } = await start();
  render(<App />);
  expect(screen.getByRole('alert')).toHaveTextContent('E_CONFIG_NETWORK: handshake connect: connection refused');
  expect(screen.getByText(/^API:/)).toHaveTextContent('http://10.23.5.40:8080/c/');
  expect(screen.getByText(/^Bước:/)).toHaveTextContent('desktop_config');
  expect(screen.getByText(/^Request ID:/)).toHaveTextContent('desktop-test123');
});

it('shows an IPC permission error instead of silently discarding it', async () => {
  vi.mocked(desktopCommands.appInfo).mockRejectedValue('app_info not allowed by capability');
  const { App } = await start();
  render(<App />);
  expect(screen.getByRole('alert')).toHaveTextContent('app_info not allowed by capability');
  expect(desktopCommands.desktopConfig).not.toHaveBeenCalled();
});
