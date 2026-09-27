import { useMemo, useState } from 'react'
import { Linking, SafeAreaView, StatusBar, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { WebView } from 'react-native-webview'

const initialUrl = process.env.EXPO_PUBLIC_TORCHIKO_APP_URL || 'http://localhost:4175/app/city-sc'
const configuredBackground = process.env.EXPO_PUBLIC_TORCHIKO_APP_BACKGROUND || '#ffffff'
const appBackground = /^#[\da-fA-F]{6}$/.test(configuredBackground) ? configuredBackground : '#ffffff'
const tabs = ['Home', 'Tickets', 'Map', 'Ask']

export default function App() {
  const [activeTab, setActiveTab] = useState('Ask')
  const [loadError, setLoadError] = useState(false)
  const [retryKey, setRetryKey] = useState(0)
  const appOrigin = useMemo(() => {
    try { return new URL(initialUrl).origin } catch { return '' }
  }, [])

  const openExternal = (url) => {
    if (!url) return
    Linking.openURL(url).catch(() => {})
  }

  const allowWebNavigation = (request) => {
    if (request.isTopFrame === false) return true
    if (request.url === 'about:blank' || request.url === 'about:srcdoc') return true
    let parsed
    try { parsed = new URL(request.url) } catch { return false }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      if (['tel:', 'mailto:', 'geo:', 'maps:', 'comgooglemaps:'].includes(parsed.protocol)) openExternal(request.url)
      return false
    }
    if (parsed.origin !== appOrigin) {
      openExternal(request.url)
      return false
    }
    return true
  }

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: appBackground }]}>
      <StatusBar barStyle="dark-content" backgroundColor={appBackground} />
      <View style={styles.content}>
        <View
          style={[styles.webviewHost, { backgroundColor: appBackground }, activeTab !== 'Ask' && styles.hidden]}
          pointerEvents={activeTab === 'Ask' ? 'auto' : 'none'}
          accessibilityElementsHidden={activeTab !== 'Ask'}
          importantForAccessibility={activeTab === 'Ask' ? 'auto' : 'no-hide-descendants'}
        >
          <WebView
            key={retryKey}
            source={{ uri: initialUrl }}
            style={[styles.webview, { backgroundColor: appBackground }]}
            originWhitelist={['*']}
            javaScriptEnabled
            domStorageEnabled
            geolocationEnabled
            mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
            onShouldStartLoadWithRequest={allowWebNavigation}
            onOpenWindow={({ nativeEvent }) => openExternal(nativeEvent.targetUrl)}
            onError={() => setLoadError(true)}
            onHttpError={({ nativeEvent }) => { if (nativeEvent.statusCode >= 500) setLoadError(true) }}
            allowsBackForwardNavigationGestures={false}
            onContentProcessDidTerminate={() => setRetryKey((key) => key + 1)}
            onRenderProcessGone={() => setRetryKey((key) => key + 1)}
            bounces={false}
          />
        </View>
        {activeTab !== 'Ask' && (
          <View style={[styles.placeholder, { backgroundColor: appBackground }]}>
            <Text style={styles.placeholderTitle}>{activeTab}</Text>
            <Text style={styles.placeholderCopy}>Native shell placeholder for distribution testing.</Text>
          </View>
        )}
        {loadError && activeTab === 'Ask' && (
          <View style={[styles.retry, { backgroundColor: appBackground }]}>
            <Text style={styles.retryTitle}>Guide could not load</Text>
            <Text style={styles.retryCopy}>Check your connection and try again.</Text>
            <TouchableOpacity onPress={() => { setLoadError(false); setRetryKey((value) => value + 1) }}><Text style={styles.retryLink}>Retry</Text></TouchableOpacity>
          </View>
        )}
      </View>
      <View style={styles.tabBar}>
        {tabs.map((tab) => (
          <TouchableOpacity key={tab} style={styles.tab} onPress={() => { setActiveTab(tab) }} accessibilityRole="tab" accessibilityState={{ selected: activeTab === tab }}>
            <Text style={[styles.tabLabel, activeTab === tab && styles.tabLabelActive]}>{tab}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#fff' },
  content: { flex: 1, position: 'relative' },
  webviewHost: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  hidden: { opacity: 0 },
  webview: { flex: 1, backgroundColor: '#fff' },
  tabBar: { height: 64, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#d2dce0', flexDirection: 'row', backgroundColor: '#fff' },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tabLabel: { color: '#647782', fontSize: 12, fontWeight: '600' },
  tabLabelActive: { color: '#087f8c' },
  placeholder: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#fff' },
  placeholderTitle: { color: '#142b39', fontSize: 24, fontWeight: '700' },
  placeholderCopy: { color: '#526673', marginTop: 8, textAlign: 'center' },
  retry: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#fff' },
  retryTitle: { fontSize: 20, fontWeight: '700', color: '#142b39' },
  retryCopy: { marginTop: 8, color: '#526673' },
  retryLink: { marginTop: 16, color: '#087f8c', fontWeight: '700' },
})
