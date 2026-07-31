import { useState } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  Uri,
  fetchOhttpKeys,
  parsePjUri,
  toSats,
  type JsonReceiverSessionPersister,
} from 'react-native-payjoin';

/**
 * Two checks, cheapest first.
 *
 * 1. Parsing a BIP21 URI exercises the whole stack — JSI -> C++ -> uniffi ->
 *    Rust — with no wallet, relay, or network involved.
 * 2. Fetching OHTTP keys proves the async path and the Rust-side HTTP CONNECT
 *    proxying that React Native's own `fetch` cannot do.
 */
const SAMPLE_URI =
  'bitcoin:2MuyMrZHkbHbfjudmrnio3hmMdyd8dHwEB?amount=0.0001&pj=https://payjo.in';

// Public test infrastructure. Swap for your own in production.
const OHTTP_RELAY = 'https://pj.bobspacebkk.com';
const DIRECTORY = 'https://payjo.in';

/**
 * Minimal in-memory persister so the example runs standalone.
 *
 * NOT for production: a killed app loses the session, and payjoin sessions hold
 * funds-relevant state. Back a real one with MMKV, AsyncStorage, or SQLite.
 *
 * `load()` MUST return events in insertion order — the session is rebuilt by
 * replaying this log, so reordering corrupts it.
 */
function createMemoryPersister(): JsonReceiverSessionPersister {
  const events: string[] = [];
  return {
    save: (event: string) => {
      events.push(event);
    },
    load: () => [...events],
    close: () => {},
  };
}

export default function App() {
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const log = (line: string) => setLines((prev) => [...prev, line]);

  const parseUri = () => {
    setLines([]);
    try {
      const uri = Uri.parse(SAMPLE_URI);
      log(`address:  ${uri.address()}`);

      const amount = uri.amountSats();
      log(`amount:   ${amount === undefined ? 'none' : `${toSats(amount)} sats`}`);

      // The gate between a plain BIP21 URI and one that can start a session.
      const pjUri = parsePjUri(SAMPLE_URI);
      log(`endpoint: ${pjUri.pjEndpoint()}`);
      log('');
      log('Bindings loaded. ✅');
    } catch (e) {
      log(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const fetchKeys = async () => {
    setLines([]);
    setBusy(true);
    try {
      log(`relay:     ${OHTTP_RELAY}`);
      log(`directory: ${DIRECTORY}`);
      log('fetching OHTTP keys...');

      // Async Rust over JSI, proxied through an HTTP CONNECT relay so the
      // directory never sees this device's IP.
      await fetchOhttpKeys(OHTTP_RELAY, DIRECTORY);

      log('');
      log('OHTTP keys fetched. ✅');
      log('Async + networking path works.');
    } catch (e) {
      log(`error: ${e instanceof Error ? e.message : String(e)}`);
      log('');
      log('Needs a reachable relay/directory.');
    } finally {
      setBusy(false);
    }
  };

  const inspectPersister = () => {
    setLines([]);
    const persister = createMemoryPersister();
    persister.save('{"example":"event"}');
    log(`persister events: ${persister.load().length}`);
    log('');
    log('Persister interface satisfied. ✅');
    log('Back it with MMKV/SQLite for real use.');
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>react-native-payjoin</Text>
        <Text style={styles.subtitle}>Payjoin Dev Kit · BIP 77 / BIP 78</Text>

        <TouchableOpacity style={styles.button} onPress={parseUri} disabled={busy}>
          <Text style={styles.buttonText}>1 · Parse sample URI</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, busy && styles.buttonDisabled]}
          onPress={fetchKeys}
          disabled={busy}
        >
          <Text style={styles.buttonText}>
            {busy ? 'Fetching…' : '2 · Fetch OHTTP keys (async)'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.buttonAlt} onPress={inspectPersister} disabled={busy}>
          <Text style={styles.buttonAltText}>3 · Check persister interface</Text>
        </TouchableOpacity>

        <View style={styles.output}>
          {lines.length === 0 ? (
            <Text style={styles.muted}>Run a check to verify the native module.</Text>
          ) : (
            lines.map((line, i) => (
              <Text key={i} style={styles.mono}>
                {line}
              </Text>
            ))
          )}
        </View>

        <Text style={styles.footnote}>
          A full send/receive needs a funded wallet for the PSBT and signing. See
          payjoinSend / payjoinReceive in the README.
        </Text>
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
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  buttonAlt: {
    borderWidth: 1,
    borderColor: '#111',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  buttonAltText: { color: '#111', fontSize: 16, fontWeight: '600' },
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
  footnote: { marginTop: 16, fontSize: 12, color: '#888', lineHeight: 18 },
});
