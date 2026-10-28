/** Canned uiautomator dumps shared by the tests. */
export const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="false" bounds="[0,0][1080,2400]">
<node index="0" text="Delivery" resource-id="com.example.app:id/tab_delivery" class="android.widget.TextView" content-desc="" checked="true" clickable="true" bounds="[0,100][540,200]" />
<node index="1" text="QA single copy &amp; more" resource-id="com.example.app:id/banner_title" class="android.widget.TextView" content-desc="" checked="false" clickable="false" bounds="[40,300][1040,380]" />
<node index="2" text="Join" resource-id="com.example.app:id/cta" class="android.widget.Button" content-desc="" checked="false" clickable="true" bounds="[800,400][1000,500]" />
<node index="3" text="" resource-id="com.example.app:id/cashback_info_icon" class="android.widget.ImageView" content-desc="Info" checked="false" clickable="true" bounds="[0,0][0,0]" />
<node index="4" text="" resource-id="com.example.app:id/menu" class="android.widget.ImageButton" content-desc="Open &quot;menu&quot;" checked="false" clickable="true" bounds="[980,100][1080,200]" />
</node></hierarchy>`;

/** Screen shown after a tap: checkout, no CTA. */
export const AFTER_TAP_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="false" bounds="[0,0][1080,2400]">
<node index="0" text="Checkout" resource-id="com.example.app:id/title" class="android.widget.TextView" content-desc="" checked="false" clickable="false" bounds="[0,100][1080,200]" />
<node index="1" text="Standard Plan" resource-id="com.example.app:id/plan" class="android.widget.TextView" content-desc="" checked="false" clickable="true" bounds="[0,300][1080,400]" />
</node></hierarchy>`;
