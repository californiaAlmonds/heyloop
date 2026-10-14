import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';

type Notifications = typeof import('expo-notifications');

let loaded: Promise<Notifications | undefined> | undefined;

/** Remote push needs a dev/production build; Expo Go (and non-Android) gets no push. */
function notifications(): Promise<Notifications | undefined> {
  loaded ??= (async () => {
    if (Platform.OS !== 'android' || Constants.executionEnvironment === ExecutionEnvironment.StoreClient) return undefined;
    const N = await import('expo-notifications');
    // The in-app UI already shows live activity, so doorbells are silent while the app is open.
    N.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
    return N;
  })();
  return loaded;
}

/** Native FCM token, or undefined if push is unavailable or the user declined. */
export async function getPushToken(): Promise<string | undefined> {
  const N = await notifications();
  if (!N) return undefined;
  try {
    // Channels must exist before Android 13 shows the permission prompt; ids match the relay's FCM payload.
    await N.setNotificationChannelAsync('approvals', { name: 'Approvals', importance: N.AndroidImportance.HIGH });
    await N.setNotificationChannelAsync('updates', { name: 'Updates', importance: N.AndroidImportance.DEFAULT });
    let permission = await N.getPermissionsAsync();
    if (!permission.granted && permission.canAskAgain) permission = await N.requestPermissionsAsync();
    if (!permission.granted) return undefined;
    const token = await N.getDevicePushTokenAsync();
    return typeof token.data === 'string' ? token.data : undefined;
  } catch {
    return undefined;
  }
}

/** Calls back when FCM rotates the device token while the app is running. */
export function watchPushToken(onToken: (token: string) => void): void {
  void notifications().then((N) => {
    N?.addPushTokenListener((token) => {
      if (typeof token.data === 'string') onToken(token.data);
    });
  });
}
