package com.yuepi.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.pdf.PdfRenderer;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native PDF rendering engine (Android 内置 PdfRenderer，无第三方 .so)。
 * - 渲染/尺寸由系统 PdfRenderer 完成（原生 Skia，快且稳定；天然兼容 16KB 页面设备）
 * - 文本提取由网页端 pdf.js 负责（PdfRenderer 无文本 API）
 * - 不支持加密 PDF（构造会抛 SecurityException，由网页提示）
 *
 * 所有操作在后台线程串行执行，不阻塞 WebView 主线程。
 */
@CapacitorPlugin(name = "YuepiPDF")
public class YuepiPDFPlugin extends Plugin {

    private PdfRenderer renderer;
    private ParcelFileDescriptor fd;
    private File pdfFile;
    /** base64 open 的是临时文件，close 时删除；openByPath 打开的是用户导入的持久文件，不能删 */
    private boolean deletePdfOnClose = false;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    /** 可靠的 Context：Capacitor 桥就绪前 getContext() 可能为 null，回退到 bridge.getActivity() */
    private Context appContext() {
        Context c = getContext();
        if (c == null && getBridge() != null) c = getBridge().getActivity();
        return c;
    }

    /** 打开 PDF（data = base64 编码的 PDF 字节，中小文件） */
    @PluginMethod
    public void open(PluginCall call) {
        String dataBase64 = call.getString("data");
        if (dataBase64 == null || dataBase64.isEmpty()) {
            call.reject("data (base64) required");
            return;
        }
        executor.execute(() -> {
            try {
                byte[] bytes = Base64.decode(dataBase64, Base64.DEFAULT);
                closeInternal();
                Context ctx = appContext();
                if (ctx == null) { call.reject("context unavailable"); return; }
                pdfFile = File.createTempFile("yuepi", ".pdf", ctx.getCacheDir());
                deletePdfOnClose = true;
                try (FileOutputStream fos = new FileOutputStream(pdfFile)) {
                    fos.write(bytes);
                }
                fd = ParcelFileDescriptor.open(pdfFile, ParcelFileDescriptor.MODE_READ_ONLY);
                renderer = new PdfRenderer(fd); // 加密 PDF 会在此抛 SecurityException
                JSObject ret = new JSObject();
                ret.put("pageCount", renderer.getPageCount());
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("open failed: " + e.getMessage());
            }
        });
    }

    /** 返回全部页面尺寸（PDF points ≈ CSS px，可直接映射批注坐标） */
    @PluginMethod
    public void getInfo(PluginCall call) {
        executor.execute(() -> {
            try {
                if (renderer == null) { call.reject("no document"); return; }
                int count = renderer.getPageCount();
                JSONArray pages = new JSONArray();
                for (int i = 0; i < count; i++) {
                    try (PdfRenderer.Page page = renderer.openPage(i)) {
                        JSObject p = new JSObject();
                        p.put("width", page.getWidth());
                        p.put("height", page.getHeight());
                        pages.put(p);
                    }
                }
                JSObject ret = new JSObject();
                ret.put("pageCount", count);
                ret.put("pages", pages);
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("getInfo failed: " + e.getMessage());
            }
        });
    }

    /** 渲染指定页为 JPEG（scale = 物理像素 / PDF 点）；单边最大 4096px，防超大 Bitmap 崩溃 */
    @PluginMethod
    public void renderPage(PluginCall call) {
        Integer page = call.getInt("page");
        Double scale = call.getDouble("scale", 1.0);
        if (page == null) { call.reject("page required"); return; }
        executor.execute(() -> {
            try {
                if (renderer == null) { call.reject("no document"); return; }
                try (PdfRenderer.Page p = renderer.openPage(page)) {
                    int w = p.getWidth();
                    int h = p.getHeight();
                    int width = Math.max(1, (int) Math.round(w * scale));
                    int height = Math.max(1, (int) Math.round(h * scale));
                    // 限制最大边长，避免超大 Bitmap 触发 OOM/崩溃
                    int maxDim = 4096;
                    if (width > maxDim || height > maxDim) {
                        double fit = Math.min(1.0, (double) maxDim / Math.max(width, height));
                        width = Math.max(1, (int) Math.round(width * fit));
                        height = Math.max(1, (int) Math.round(height * fit));
                    }
                    Bitmap bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
                    bmp.eraseColor(Color.WHITE);
                    Matrix matrix = new Matrix();
                    matrix.postScale((float) width / w, (float) height / h);
                    p.render(bmp, null, matrix, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                    ByteArrayOutputStream baos = new ByteArrayOutputStream();
                    bmp.compress(Bitmap.CompressFormat.JPEG, 85, baos);
                    bmp.recycle();
                    JSObject ret = new JSObject();
                    ret.put("data", "data:image/jpeg;base64," + Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP));
                    ret.put("width", width);
                    ret.put("height", height);
                    call.resolve(ret);
                }
            } catch (Throwable e) {
                // Throwable（含 OutOfMemoryError）：不闪退，返回错误由网页降级重试
                call.reject("render failed: " + e.getMessage());
            }
        });
    }

    /** 返回原始 PDF 字节（base64，导出带批注 PDF 用） */
    @PluginMethod
    public void getBytes(PluginCall call) {
        executor.execute(() -> {
            try {
                if (pdfFile == null || !pdfFile.exists()) { call.reject("no document"); return; }
                byte[] bytes = new byte[(int) pdfFile.length()];
                try (FileInputStream fis = new FileInputStream(pdfFile)) {
                    int off = 0;
                    while (off < bytes.length) {
                        int n = fis.read(bytes, off, bytes.length - off);
                        if (n < 0) break;
                        off += n;
                    }
                }
                JSObject ret = new JSObject();
                ret.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("getBytes failed: " + e.getMessage());
            }
        });
    }

    /** 关闭文档并释放资源 */
    @PluginMethod
    public void close(PluginCall call) {
        executor.execute(() -> {
            closeInternal();
            call.resolve();
        });
    }

    // ==================== 大文件导入：系统文件选择器 + 原生直读（不走 base64/IndexedDB） ====================

    /** 打开系统文件选择器，把选中的 PDF 复制到 app 私有目录，返回 { id, name, size, path } */
    @PluginMethod
    public void pickFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/pdf");
        startActivityForResult(call, intent, "pickFileResult");
    }

    @ActivityCallback
    private void pickFileResult(PluginCall call, androidx.activity.result.ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("picked cancelled");
            return;
        }
        Uri uri = result.getData().getData();
        executor.execute(() -> {
            try {
                Context ctx = appContext();
                if (ctx == null) { call.reject("context unavailable"); return; }
                String name = queryDisplayName(ctx, uri);
                String id = "pdf-" + System.currentTimeMillis();
                File dir = new File(ctx.getFilesDir(), "docs");
                if (!dir.exists()) dir.mkdirs();
                File dest = new File(dir, id + ".pdf");
                try (InputStream in = ctx.getContentResolver().openInputStream(uri);
                     FileOutputStream fos = new FileOutputStream(dest)) {
                    if (in == null) { call.reject("cannot read picked file"); return; }
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) fos.write(buf, 0, n);
                }
                JSObject ret = new JSObject();
                ret.put("id", id);
                ret.put("name", name == null || name.isEmpty() ? "未命名.pdf" : name);
                ret.put("size", dest.length());
                ret.put("path", dest.getAbsolutePath());
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("pick failed: " + e.getMessage());
            }
        });
    }

    private String queryDisplayName(Context ctx, Uri uri) {
        try (android.database.Cursor c = ctx.getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) return c.getString(idx);
            }
        } catch (Throwable ignored) { }
        return null;
    }

    /** 按绝对路径打开 PDF（大文件：原生直接读文件，返回页数与页面尺寸） */
    @PluginMethod
    public void openByPath(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) { call.reject("path required"); return; }
        executor.execute(() -> {
            try {
                closeInternal();
                Context ctx = appContext();
                if (ctx == null) { call.reject("context unavailable"); return; }
                pdfFile = new File(path);
                deletePdfOnClose = false; // 用户导入的持久文件，close 时不能删
                if (!pdfFile.exists()) { call.reject("file not found: " + path); return; }
                fd = ParcelFileDescriptor.open(pdfFile, ParcelFileDescriptor.MODE_READ_ONLY);
                renderer = new PdfRenderer(fd);
                int count = renderer.getPageCount();
                JSONArray pages = new JSONArray();
                for (int i = 0; i < count; i++) {
                    try (PdfRenderer.Page page = renderer.openPage(i)) {
                        JSObject p = new JSObject();
                        p.put("width", page.getWidth());
                        p.put("height", page.getHeight());
                        pages.put(p);
                    }
                }
                JSObject ret = new JSObject();
                ret.put("pageCount", count);
                ret.put("pages", pages);
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("openByPath failed: " + e.getMessage());
            }
        });
    }

    /** 删除 app 私有目录里的 PDF 文件（删除文档时调用） */
    @PluginMethod
    public void deleteFile(PluginCall call) {
        String path = call.getString("path");
        executor.execute(() -> {
            try {
                if (path != null) new File(path).delete();
                call.resolve();
            } catch (Throwable e) {
                call.reject("delete failed: " + e.getMessage());
            }
        });
    }

    private void closeInternal() {
        try { if (renderer != null) renderer.close(); } catch (Throwable ignored) { }
        try { if (fd != null) fd.close(); } catch (Throwable ignored) { }
        if (deletePdfOnClose && pdfFile != null && pdfFile.exists()) pdfFile.delete();
        renderer = null;
        fd = null;
        pdfFile = null;
        deletePdfOnClose = false;
    }
}
