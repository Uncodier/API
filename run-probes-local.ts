import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

// Ejecutar el script original programáticamente
import('./scripts/run-system-probes.ts').catch(console.error);
