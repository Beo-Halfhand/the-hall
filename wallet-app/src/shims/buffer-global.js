// The address decoder expects Node's Buffer. Imported first, so it's there before anything needs it.
import { Buffer } from 'buffer';

globalThis.Buffer ??= Buffer;
