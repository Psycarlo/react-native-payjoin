import { useState } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Uri } from 'react-native-payjoin';

/**
 * Smoke test for the native bindings.
 *
 * Parsing a BIP21 URI touches the full stack — JSI -> C++ -> uniffi -> Rust —
 * without needing a wallet, a relay, or network access, so it is the cheapest
 * way to prove the TurboModule loaded and the bindings are wired up.
 */
const SAMPLE_URI =
  'bitcoin:2MuyMrZHkbHbfjudmrnio3hmMdyd8dHwEB?amount=0.0001&pj=https://payjo.in';

export default function App() {
  const [lines, setLines] = useState<string[]>([]);

  const log = (line: string) => setLines((prev) => [...prev, line]);

  const runSmokeTest = () => {
    setLines([]);
    try {
      const uri = Uri.parse(SAMPLE_URI);
      log(`address:  ${uri.address()}`);
      log(`amount:   ${uri.amountSats() ?? 'none'} sats`);

      // check_pj_supported() is the gate between a plain BIP21 URI and one
      // that can actually start a payjoin session.
      const pjUri = uri.checkPjSupported();
      log(`endpoint: ${pjUri.pjEndpoint()}`);
      log('');
      log('Bindings loaded. ✅');
    } catch (e) {
      log(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>react-native-payjoin</Text>
        <Text style={styles.subtitle}>Payjoin Dev Kit · BIP 77 / BIP 78</Text>

        <TouchableOpacity style={styles.button} onPress={runSmokeTest}>
          <Text style={styles.buttonText}>Parse sample URI</Text>
        </TouchableOpacity>

        <View style={styles.output}>
          {lines.length === 0 ? (
            <Text style={styles.muted}>Tap the button to verify the native module.</Text>
          ) : (
            lines.map((line, i) => (
              <Text key={i} style={styles.mono}>
                {line}
              </Text>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 24, gap: 12 },
  title: { fontSize: 24, fontWeight: '700' },
  subtitle: { fontSize: 14, color: '#666', marginBottom: 12 },
  button: {
    backgroundColor: '#111',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  output: {
    marginTop: 16,
    padding: 16,
    borderRadius: 10,
    backgroundColor: '#f5f5f5',
    minHeight: 120,
    gap: 4,
  },
  muted: { color: '#999' },
  mono: { fontFamily: 'Courier', fontSize: 13 },
});
