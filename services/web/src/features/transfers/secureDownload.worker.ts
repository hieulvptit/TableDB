import { installSecureDownloadWorker } from '../../../../../packages/shared/src/secure-download-worker';
installSecureDownloadWorker(self as unknown as Parameters<typeof installSecureDownloadWorker>[0]);
