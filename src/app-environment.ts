export const TEST_BUILD = import.meta.env.VITE_PIZZASEND_CHANNEL === 'test';
export const TEST_REVISION = /^[a-f0-9]{7,40}$/.test(import.meta.env.VITE_PIZZASEND_REVISION || '') ? import.meta.env.VITE_PIZZASEND_REVISION.slice(0, 7) : 'local';
export const storageKey = (name: string) => TEST_BUILD ? 'pizzasend-test:' + name : name;
export const storageDirectory = (name: string) => TEST_BUILD ? name + '-test' : name;
