import type { ConfigContext, ExpoConfig } from 'expo/config';

// google-services.json is per self-hoster; EAS builds receive it as the GOOGLE_SERVICES_JSON file env var.
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  android: {
    ...config.android,
    googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? '../../.credentials/firebase/google-services.json',
  },
});
