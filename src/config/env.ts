type EnvValue = string | boolean | undefined;

type ImportMetaWithEnv = ImportMeta & {
  env?: Record<string, EnvValue>;
};

function readEnvValue(key: string): EnvValue {
  const importMetaEnv = (import.meta as ImportMetaWithEnv).env;
  if (importMetaEnv && key in importMetaEnv) {
    return importMetaEnv[key];
  }

  const processEnv = typeof process !== 'undefined' ? process.env : undefined;
  return processEnv?.[key];
}

export function getEnvString(key: string, fallback: string): string {
  const value = readEnvValue(key);
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function getEnvBoolean(key: string, fallback = false): boolean {
  const value = readEnvValue(key);
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}
