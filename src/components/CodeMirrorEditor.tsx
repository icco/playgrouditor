import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, WebViewMessageEvent, WebViewProps } from 'react-native-webview';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/types';
import type { EditorColors, EditorInbound, EditorOutbound } from '../editor/protocol';

// WebView's class typings resolve its props to never under TypeScript 6.
const EditorWebView = WebView as unknown as React.ComponentType<WebViewProps & React.RefAttributes<WebView>>;

interface Props {
  initialValue: string;
  onChangeText: (text: string) => void;
  path: string;
  preview: boolean;
}

function editorColors({ colors }: Theme): EditorColors {
  return {
    background: colors.background,
    surface: colors.surface,
    text: colors.text,
    textMuted: colors.textMuted,
    border: colors.border,
    primary: colors.primary,
    inputBg: colors.inputBg,
    'syntax-keyword': colors.syntaxKeyword,
    'syntax-string': colors.syntaxString,
    'syntax-number': colors.syntaxNumber,
    'syntax-comment': colors.syntaxComment,
    'syntax-variable': colors.syntaxVariable,
    'syntax-function': colors.syntaxFunction,
  };
}

// The document only crosses the bridge as a message, so file contents never become page markup.
export function CodeMirrorEditor({ initialValue, onChangeText, path, preview }: Props) {
  const { theme } = useTheme();
  const webViewRef = useRef<WebView>(null);
  const latestTextRef = useRef(initialValue);
  const readyRef = useRef(false);
  const [generation, setGeneration] = useState(0);
  const colors = editorColors(theme);
  const colorsKey = JSON.stringify(colors);

  function post(message: EditorInbound) {
    webViewRef.current?.injectJavaScript(`window.editorBridge.receive(${JSON.stringify(message)});true;`);
  }

  useEffect(() => {
    if (readyRef.current) post({ type: 'colors', colors: JSON.parse(colorsKey) as EditorColors });
  }, [colorsKey]);

  useEffect(() => {
    if (readyRef.current) post({ type: 'preview', on: preview });
  }, [preview]);

  function onMessage(event: WebViewMessageEvent) {
    const message = JSON.parse(event.nativeEvent.data) as EditorOutbound;
    switch (message.type) {
      case 'ready':
        readyRef.current = true;
        post({ type: 'init', doc: latestTextRef.current, path, preview, colors });
        break;
      case 'change':
        latestTextRef.current = message.doc;
        onChangeText(message.doc);
        break;
      case 'error':
        console.error('Editor error', message.message);
        break;
    }
  }

  function restart() {
    readyRef.current = false;
    setGeneration(g => g + 1);
  }

  return (
    <View style={styles.container}>
      <EditorWebView
        key={generation}
        ref={webViewRef}
        source={{ uri: 'file:///android_asset/editor/index.html' }}
        originWhitelist={['file://*']}
        style={{ backgroundColor: theme.colors.background }}
        onMessage={onMessage}
        onRenderProcessGone={restart}
        setSupportMultipleWindows
        overScrollMode="never"
        textZoom={100}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
