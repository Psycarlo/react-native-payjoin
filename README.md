![PDF Banner](https://github.com/Psycarlo/react-native-payjoin/blob/main/assets/pdk-banner.png)

<div align="center">
  <h1>react-native-payjoin</h1>
  <p>Unofficial React Native bindings for PDK</p>
</div>

<br />

Scale Bitcoin, save fees, and preserve privacy with one tiny library, on React Native using uniffi.

<br />

<div align="center">
  <a href="https://payjoindevkit.org/">PDK Website</a> ·
  <a href="https://docs.rs/payjoin">Payjoin crate</a>
</div>

## Requirements

- React Native **0.74+**
- **New Architecture enabled** (`newArchEnabled=true`) — this library uses TurboModules via JSI and does not support the old bridge. React Native 0.76+ has New Architecture on by default.

## Installation

### Expo

1. Install the package

```bash
npx expo install react-native-payjoin
```

2. Make sure the plugin is in `app.json`

```json
{
  "expo": {
    "plugins": ["react-native-payjoin"]
  }
}
```

Warning: If you are using pnpm v10+, run pnpm approve-builds and select `react-native-payjoin` to allow the postinstall script to download the prebuilt native binaries.

3. Run prebuild

```bash
npx expo prebuild
```

### Bare React Native

1. Install the package

```bash
npm install react-native-payjoin
```

Note: If you are running on iOS, navigate into the `ios` folder and run `pod install`.

## License

Released under the **MIT** license — see the [LICENSE](LICENSE) file for details.
