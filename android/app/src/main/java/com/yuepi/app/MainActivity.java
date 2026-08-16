package com.yuepi.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 注册原生 PDF 渲染插件（渲染/文本/尺寸由 Pdfium 完成，网页只负责显示与批注）
        registerPlugin(YuepiPDFPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
