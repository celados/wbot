package cc.celados.sms;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.widget.*;

public final class MainActivity extends Activity {
    private TextView status;
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        var config = getSharedPreferences("config", MODE_PRIVATE);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL); layout.setPadding(40, 50, 40, 30);
        TextView title = new TextView(this); title.setText("短信转发"); title.setTextSize(24); layout.addView(title);
        TextView help = new TextView(this);
        help.setText("选择微信或飞书，配置目标后开启。首次开启跳过旧短信；再次开启会补发停止期间的新短信。修改配置前请先停止。\n");
        layout.addView(help);
        Spinner sender = new Spinner(this);
        sender.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, new String[]{"微信（wbot）", "飞书群机器人"}));
        sender.setSelection(config.getString("sender", "wbot").equals("wbot") ? 0 : 1); layout.addView(sender);
        LinearLayout wbotFields = new LinearLayout(this); wbotFields.setOrientation(LinearLayout.VERTICAL);
        EditText origin = field(wbotFields, "wbot API 地址", config.getString("origin", "https://wbot-api-prod.celados.com"), false);
        EditText key = field(wbotFields, "API Key", config.getString("key", ""), true);
        EditText conversation = field(wbotFields, "目标会话 ID", config.getString("conversation", ""), false);
        layout.addView(wbotFields);
        EditText url = new EditText(this); url.setHint("飞书机器人 Webhook");
        url.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        url.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        url.setText(config.getString("url", "")); layout.addView(url);
        CheckBox routing = new CheckBox(this); routing.setText("按 SIM 分流（CMCC → 私聊；AIR MOBILE → 微信群和 Slack）");
        routing.setChecked(config.getBoolean("routing_enabled", false)); layout.addView(routing);
        TextView routingHelp = new TextView(this); routingHelp.setText("订阅 ID 不是卡槽编号。换卡或更换 eSIM 后请重新核对；未知卡短信将保留待处理。旧积压仍按原配置发送。"); layout.addView(routingHelp);
        EditText cmccSub = field(layout, "CMCC 订阅 ID", Integer.toString(config.getInt("cmcc_sub_id", -1)), false);
        EditText airSub = field(layout, "AIR MOBILE 订阅 ID", Integer.toString(config.getInt("air_sub_id", -1)), false);
        EditText airConversation = field(layout, "AIR MOBILE 微信群会话 ID", config.getString("air_conversation", ""), false);
        EditText slackWebhook = field(layout, "AIR MOBILE Slack Incoming Webhook", config.getString("slack_webhook", ""), true);
        sender.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                wbotFields.setVisibility(position == 0 ? View.VISIBLE : View.GONE);
                url.setVisibility(position == 1 ? View.VISIBLE : View.GONE);
            }
            @Override public void onNothingSelected(AdapterView<?> parent) { }
        });
        Button permission = new Button(this); permission.setText("授权读取短信");
        permission.setOnClickListener(view -> requestPermissions(new String[]{Manifest.permission.READ_SMS, Manifest.permission.RECEIVE_SMS,
            Manifest.permission.POST_NOTIFICATIONS}, 1)); layout.addView(permission);
        Button start = new Button(this); start.setText("保存并开启");
        start.setOnClickListener(view -> {
            String value = url.getText().toString().trim();
            String mode = sender.getSelectedItemPosition() == 0 ? "wbot" : "feishu";
            String apiOrigin = origin.getText().toString().trim();
            String apiKey = key.getText().toString().trim();
            String target = conversation.getText().toString().trim();
            boolean routeEnabled = routing.isChecked();
            int cmcc = -1, air = -1;
            try { cmcc = Integer.parseInt(cmccSub.getText().toString().trim()); air = Integer.parseInt(airSub.getText().toString().trim()); }
            catch (NumberFormatException ignored) { }
            String group = airConversation.getText().toString().trim();
            String hook = slackWebhook.getText().toString().trim();
            if (routeEnabled && (!mode.equals("wbot") || cmcc < 0 || air < 0 || cmcc == air || group.isBlank() || !SlackSender.validUrl(hook))) {
                status.setText("分卡模式需要微信出口、两个不同的有效订阅 ID、微信群和 Slack Webhook"); return;
            }
            if (mode.equals("wbot") && (!WbotSender.validOrigin(apiOrigin) || apiKey.isBlank() || apiKey.contains("\n") || apiKey.contains("\r") || target.isBlank())) {
                status.setText("请填写 HTTPS API 地址、API Key 和目标会话 ID"); return;
            }
            if (mode.equals("feishu") && !FeishuSender.validUrl(value)) { status.setText("请填写有效的飞书群机器人 Webhook"); return; }
            if (config.getBoolean("enabled", false)) { status.setText("请先停止，再修改配置或重新开启"); return; }
            if (checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
                status.setText("请先授权读取短信"); return;
            }
            // Changing destination with retained work would redirect private SMS unexpectedly.
            try (Store store = new Store(this)) {
                boolean changed = !mode.equals(config.getString("sender", "feishu"))
                    || (mode.equals("feishu") ? !value.equals(config.getString("url", ""))
                    : !apiOrigin.equals(config.getString("origin", "")) || !apiKey.equals(config.getString("key", "")) || !target.equals(config.getString("conversation", "")));
                if (store.count() > 0 && changed) {
                    status.setText("有未处理短信，暂不能更换出口、账号或目标"); return;
                }
                boolean routeChanged = routeEnabled != config.getBoolean("routing_enabled", false)
                    || cmcc != config.getInt("cmcc_sub_id", -1) || air != config.getInt("air_sub_id", -1)
                    || !group.equals(config.getString("air_conversation", "")) || !hook.equals(config.getString("slack_webhook", ""));
                if (store.routedCount() > 0 && routeChanged) {
                    status.setText("有分卡待处理短信，暂不能更换路由或 Slack Webhook"); return;
                }
            }
            if (!config.edit().putString("sender", mode).putString("origin", apiOrigin).putString("key", apiKey)
                    .putString("conversation", target).putString("url", value).putBoolean("enabled", true)
                    .putBoolean("routing_enabled", routeEnabled).putInt("cmcc_sub_id", cmcc).putInt("air_sub_id", air)
                    .putString("air_conversation", group).putString("slack_webhook", hook).commit()) {
                status.setText("配置保存失败，未开启转发"); return;
            }
            startForegroundService(new Intent(this, ForwardService.class));
            status.setText("已开启，点刷新查看状态");
        }); layout.addView(start);
        Button stop = new Button(this); stop.setText("停止转发");
        stop.setOnClickListener(view -> {
            config.edit().putBoolean("enabled", false).commit();
            stopService(new Intent(this, ForwardService.class)); status.setText("已停止；已经提交的请求可能仍会完成");
        }); layout.addView(stop);
        Button refresh = new Button(this); refresh.setText("刷新状态");
        refresh.setOnClickListener(view -> refresh()); layout.addView(refresh);
        status = new TextView(this); layout.addView(status);
        ScrollView scroll = new ScrollView(this); scroll.addView(layout);
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            var bars = insets.getInsets(android.view.WindowInsets.Type.systemBars());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom); return insets;
        });
        setContentView(scroll); refresh();
        if (config.getBoolean("enabled", false)) startForegroundService(new Intent(this, ForwardService.class));
    }
    private EditText field(LinearLayout layout, String label, String value, boolean secret) {
        EditText input = new EditText(this); input.setHint(label); input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | (secret ? InputType.TYPE_TEXT_VARIATION_PASSWORD : InputType.TYPE_TEXT_VARIATION_URI));
        input.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO); input.setText(value); layout.addView(input); return input;
    }
    private void refresh() {
        var config = getSharedPreferences("config", MODE_PRIVATE);
        try (Store store = new Store(this)) {
            StringBuilder text = new StringBuilder(config.getString("status", "尚未开启"));
            try (var rows = store.getReadableDatabase().rawQuery("SELECT state,COUNT(*) FROM outbox GROUP BY state", null)) {
                while (rows.moveToNext()) text.append("\n旧队列 ").append(rows.getString(0)).append(": ").append(rows.getLong(1));
            }
            try (var rows = store.getReadableDatabase().rawQuery("SELECT destination,state,COUNT(*) FROM deliveries GROUP BY destination,state", null)) {
                while (rows.moveToNext()) text.append("\n").append(rows.getString(0)).append(" ").append(rows.getString(1)).append(": ").append(rows.getLong(2));
            }
            if (config.getBoolean("routing_enabled", false)) text.append("\n分卡转发已配置；未知卡保留，unknown 需人工核对。\n分卡队列：").append(store.routedCount());
            text.append("\n后台运行；重启首次解锁后自动恢复。通知栏保留运行状态。");
            status.setText(text.toString());
        }
    }
}
