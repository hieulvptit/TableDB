// Union of every message (tests / typing only). Runtime code imports the per-target parts through ./index.
import { viCommon } from './vi.common';
import { viDesktop } from './vi.desktop';
import { viWeb } from './vi.web';

export const vi = { ...viCommon, ...viWeb, ...viDesktop } as const;
export type Messages = { [K in keyof typeof vi]: string };
