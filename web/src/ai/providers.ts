/** The label of each provider the server can use, as the consent dialog names it. */
export const PROVIDER_LABELS = { anthropic: 'Anthropic', deepseek: 'DeepSeek' } as const;
export type Provider = keyof typeof PROVIDER_LABELS;
