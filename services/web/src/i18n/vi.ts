// Union of every message (tests / typing only).
import { viCommon } from './vi.common';
import { viWeb } from './vi.web';

export const vi = { ...viCommon, ...viWeb } as const;
export type Messages = { [K in keyof typeof vi]: string };
