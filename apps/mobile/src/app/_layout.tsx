import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';
import { client } from '@/lib/client';

export default function RootLayout() {
  const scheme = useColorScheme();

  useEffect(() => {
    void client.init();
  }, []);

  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="index" options={{ title: 'HeyLoop' }} />
        <Stack.Screen name="pair" options={{ title: 'Pair computer' }} />
        <Stack.Screen name="chat/[id]" options={{ title: '' }} />
      </Stack>
      <StatusBar style="auto" />
    </ThemeProvider>
  );
}
