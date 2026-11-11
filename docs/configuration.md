# 閰嶇疆鍙傝€?

> 绗竴鐗堟病鏈?UI锛氶厤缃啓鍦?profile 鐨?`cordis.patch.yml`锛堝叏灞€锛夈€侀」鐩牴鐨?
> `.meetingstone.json`锛堥」鐩骇锛変笌 `.meetingstone/sessions/<sessionId>.json`锛堜細璇濈骇锛夈€?
> 鏀瑰畬**閲嶅惎 DSH** 鐢熸晥锛堝叏灞€閰嶇疆鍦ㄦ彃浠跺姞杞芥椂璇诲彇锛涢」鐩?浼氳瘽閰嶇疆鎸夎皟鐢ㄨ鍙栵紝鏀瑰畬涓嬩竴娆″伐鍏疯皟鐢ㄥ嵆鐢熸晥锛夈€?

## 1. 鍏ㄥ眬閰嶇疆锛坧rofile 鐨?`cordis.patch.yml`锛?

```yaml
- id: meetingstone
  name: dsh-meetingstone
  config:
    channels: [...]      # 閫氶亾瀹炰緥琛紙瑙?搂2锛?
    roles: [...]         # 瑙掕壊琛紙瑙?搂3锛?
    defaultRoleId: role-sashi
    routingRules: []     # 鑷姩璺敱瑙勫垯琛紙绌?= 鐢ㄥ唴缃〃锛涜 搂1.2锛?
    dispatchNotes: "甯歌瀹炵幇浼樺厛娌欏儳锛涘叧閿敼鍔ㄤ氦鎮熺┖澶嶆牳銆?
    projectConfigFile: .meetingstone.json
    limits:
      serializeWrites: true              # isolation:none 鏃跺悓椤圭洰涓茶锛堟纭€т繚鎶わ紝涓嶆槸骞跺彂棰濆害锛?
      maxParallelWritesTotal: 4          # 鏈彃浠舵淳鍙戠殑骞惰鍐欎换鍔″叏灞€涓婇檺锛堜粎鏈彃浠讹紝榛樿 4锛?
      defaultIsolation: worktree         # worktree | none
```

> 鈿狅笍 patch 鏄?*鏁村€兼浛鎹?*锛氳鐩栬繖涓€琛屾椂瑕佹妸鏁翠釜 `config` 鍐欏叏锛屼笉鏄繁鍚堝苟銆?

### 1.1 骞惰涓庡伐浣滄爲闅旂

`meetingstone_dispatch` 榛樿 `isolation:'worktree'`锛氭瘡涓换鍔″湪
`<projectRoot>/.meetingstone/worktrees/<operationId>` 鐨勭嫭绔?git 宸ヤ綔鏍戦噷鎵ц锛?
鍒嗘敮涓?`meetingstone/<operationId>`銆傝瑙?[宸ヤ綔鏍戦殧绂籡(worktree-isolation.md)銆?

| 閰嶇疆 | 榛樿 | 璇存槑 |
| --- | --- | --- |
| `limits.defaultIsolation` | `worktree` | `worktree`=姣忎换鍔＄嫭绔嬪伐浣滄爲锛沗none`=涓诲伐浣滃尯 |
| `limits.maxParallelWritesTotal` | `4` | 鏈彃浠舵淳鍙戠殑骞惰鍐欎换鍔″叏灞€涓婇檺锛堜粎缁熻鏈彃浠朵换鍔★級锛涜秴闄愮珛鍗宠繑鍥?`WRITE_LIMIT_TOTAL`锛?*涓嶆帓闃?* |
| `limits.serializeWrites` | `true` | 浠呭湪 `isolation:none` 鏃剁敓鏁堬細鍚岄」鐩覆琛屻€傝繖鏄悓涓€宸ヤ綔鍖虹殑**姝ｇ‘鎬т繚鎶わ紝涓嶆槸骞跺彂棰濆害** |

骞跺彂绾緥锛?026-11-11 鐢ㄦ埛鍐崇瓥鍚庣殑鏂版ā鍨嬶級锛?

- **瀹夸富瀹归噺浜ょ粰瀹夸富**锛氬涓?`maxActiveSubagents` 榛樿 **8**锛屾槸**杩涚▼鍐呭叡浜睜**鈥斺€斿涓昏嚜宸辩殑瀛?Agent 涓庢湰鎻掍欢娲惧崟閮借鍏ャ€傛睜婊℃椂瀹夸富鐩存帴鎶?`ACTIVATION_LIMIT_REACHED`锛?*娌℃湁绛夊緟/鎺掗槦鏈哄埗**锛涙彃浠跺師鏍烽€忎紶杩欎釜閿欒鐮侊紝涓嶉噸澶嶅疄鐜板閲忔帶鍒讹紝涔熶笉鍖呮垚 `ADAPTER_FAILED`銆?
- **鎻掍欢鍙繚鐣欏叏灞€棰濆害**锛歚limits.maxParallelWritesTotal`锛堥粯璁?4锛夊彧缁熻**鏈彃浠舵淳鍙?*鐨勫湪璺戜换鍔★紝涓嶆寜閫氶亾/椤圭洰鎷嗗垎銆傞搴﹀湪**棣栨寮傛鎿嶄綔鍓?*锛堝惈寤烘爲锛夐鍗狅紱瓒呴檺**绔嬪嵆鎷掔粷** `WRITE_LIMIT_TOTAL`锛屼笉鎺掗槦锛岃皟鐢ㄦ柟绋嶅悗閲嶈瘯銆?
- `isolation:none` 涓庨殧绂讳换鍔?*涓嶅緱娣疯窇**锛屽悓椤圭洰浠讳竴鏂瑰悜鏈夋椿鍔ㄤ换鍔″氨杩斿洖 `WRITE_CONFLICT`锛堟纭€т繚鎶わ紝涓嶆槸棰濆害锛夈€?
- 璇锋眰闅旂浣嗗缓鏍戝け璐?/ 鏈嶅姟缂哄け 鈫?**鎷掔粷娲惧崟**锛岀粷涓嶉€€鍥炰富宸ヤ綔鍖恒€?
- 瀹屾垚 / 澶辫触 / 鍙栨秷 / 鍗歌浇閮?*涓嶅垹闄?*宸ヤ綔鏍戜笌鍒嗘敮銆?
- **闅旂鏄枃浠跺竷灞€闅旂锛屼笉鏄潈闄愭矙绠?*锛堝悓璐﹀彿銆佸悓鏂囦欢绯荤粺銆佸叡浜?git 鍏冩暟鎹級銆?

### 1.2 鑷姩瑙掕壊璺敱锛圥1-B锛岃鍒欏紡锛?

`meetingstone_dispatch` 鐨?`role` 鐜板湪鏄?*鍙€?*鐨勶紱浣嗏€滀笉鎸囧畾瑙掕壊鈥濆繀椤绘樉寮忓紑鍏筹細

| 璋冪敤鏂瑰紡 | 琛屼负 |
| --- | --- |
| 浼?`role`锛堟棫鐢ㄦ硶锛?| **鏄惧紡鎸囧畾浼樺厛**锛屽畬鍏ㄤ笉璧拌鍒欒矾鐢憋紱鍥炴墽 `routing:{roleId, auto:false}`锛屼笉鍐?reason |
| 涓嶄紶 `role` + `autoRoute:true` | 鎸変笅闈㈣鍒欒〃閫夎鑹诧紱鍥炴墽 `routing:{roleId, reason, auto:true}`锛宺eason 鍚屾椂钀界洏 |
| 涓嶄紶 `role` + 鏈紑 `autoRoute` | 鏄庣‘鎶?`ROLE_REQUIRED`锛屼笉浼氬伔鍋风敤 `defaultRoleId` |

鍐呯疆瑙勫垯琛紙`src/dispatch/routing.js` 鐨?`DEFAULT_ROUTING_RULES`锛夛細

| 浠诲姟绫诲瀷 | 鍒ゅ畾鍏抽敭璇嶏紙绀轰緥锛?| 鐩爣瑙掕壊锛堟寜瑙掕壊鏍囪瘑鍖归厤锛?| reason 鏍囩 |
| --- | --- | --- | --- |
| `architecture` | architecture / architect / 鏋舵瀯 / 鍐崇瓥 / 閫夊瀷 / 鎶€鏈柟妗?| roleId/name/aliases/description 鍚灦鏋勩€佸喅绛栥€佽璁°€乴ead銆侀瀵?| 璇勫/鍐崇瓥 |
| `review` | review / 瀹℃煡 / 璇勫 / 澶嶆牳 / 瀹℃牳 / 瀹¤ / 楠屾敹 | 鍚?review銆乺eviewer銆佸鏌ャ€佽瘎瀹°€佸鏍搞€佸鏍搞€佸璁°€侀獙鏀?| 璇勫 |
| `research` | research / investigate / 璋冪爺 / 鐮旂┒ / 璋冩煡 / 鎺㈢储 / 鍒嗘瀽 | 鍚?research銆乺esearcher銆乻cout銆佽皟鐮斻€佺爺绌躲€佽皟鏌ャ€佹帰绱€佸垎鏋?| 璋冪爺 |
| `edit` | edit / implement / fix / refactor / 瀹炵幇 / 淇 / 淇敼 / 寮€鍙?/ 閲嶆瀯 / 鏀?| 鍚?implement銆乨eveloper銆佹墽琛屻€佸疄鐜般€佷慨澶嶃€佸紑鍙戙€佷富鍔涖€侀骞?| 鎵ц |

纭畾鎬ц鍒欙細

1. **鍏堢湅鍏抽敭璇嶉娆″嚭鐜扮殑浣嶇疆**锛氫换鍔￠噷 `淇 review 鎸囧嚭鐨勯棶棰榒 褰掓墽琛岋紝`review 骞朵慨澶峘 褰掕瘎瀹★紱鍚屼綅缃椂鎸夎鍒欒〃椤哄簭銆?
2. **鍙粠 `enabled !== false` 涓?`availability === 'available'` 鐨勮鑹蹭腑閫?*銆傚仠鐢ㄣ€乸rovider 鏈畨瑁呫€佸埆鍚嶆涔夌殑瑙掕壊閮戒笉鍙備笌锛涘彲鐢ㄨ鑹蹭负 0 鈫?`AUTO_ROUTE_FAILED`銆?
3. **瑙掕壊鍖归厤椤哄簭**锛氳鍒?`roleIds` 鏄惧紡鎸囧畾 鈫?`roleId`/`name`/`aliases` 鍛戒腑 鈫?`description` 鍛戒腑 鈫?`prompt` 鍛戒腑锛堝急淇″彿鍏滃簳锛夆啋 瑙掕壊琛ㄩ『搴忋€傛暣娈?prompt 鍙敤鏉ユ壘鍏抽敭璇嶏紝reason 涔熷彧浼氬洖鏄惧懡涓殑鍏抽敭璇嶃€?
4. **鍏滃簳**锛氫换鍔＄被鍨嬫病鏈夊尮閰嶅埌鍙敤瑙掕壊銆佹垨瀹屽叏娌″懡涓叧閿瘝鏃讹紝浣跨敤鐢熸晥閰嶇疆鐨?`defaultRoleId`锛堟寜鈥滃叏灞€ 鈫?椤圭洰 鈫?浼氳瘽鈥濈户鎵匡級锛涢粯璁よ鑹叉湰韬笉鍙敤鍒?`AUTO_ROUTE_FAILED`銆?
5. **涓嶆敼鎵ц闈?*锛氳矾鐢卞彧鍐冲畾鈥滅敤鍝釜瑙掕壊鈥濓紝provider/model/reasoning/鏉冮檺缁х画鐢辫瑙掕壊鐨?`channel` 鍐冲畾锛涗笉鍒囨洿楂樻垚鏈ā鍨嬨€佷笉鎻愬崌鏉冮檺銆佷笉璋冪敤浠讳綍 AI 鍒嗙被鍣ㄣ€?

鎴愬姛鍥炴墽绀轰緥锛堣嚜鍔ㄨ矾鐢憋級锛?

```json
{
  "ok": true,
  "taskRef": { "childId": "child-1", "provider": "acp" },
  "roleId": "role-wukong",
  "roleName": "鎮熺┖",
  "isolation": "worktree",
  "routing": {
    "roleId": "role-wukong",
    "reason": "浠诲姟鍚叧閿瘝銆屽鏌ャ€嶁啋 璇勫瑙勫垯锛坮eview锛夛紝閫夋嫨銆屾偀绌恒€嶏紙role-wukong锛涜鑹叉弿杩板惈銆屽鏍搞€嶏級",
    "auto": true
  }
}
```

鎵嬪姩鎸囧畾瑙掕壊鏃?`routing` 鍙湁 `{ "roleId": "role-wukong", "auto": false }`锛堟棤 `reason`锛夈€?
`meetingstone_get_task` / `meetingstone_list_runs` 璇诲埌鐨勮惤鐩樿褰曞悓鏍峰甫 `routing`锛涙墜鍔ㄦ淳鍗曠殑
鏃ц褰曟病鏈夎瀛楁锛堜笉浼€狅級銆?

鑷畾涔夎鍒欒〃锛堝彲瑕嗙洊鍐呯疆琛紱鍙潵鑷彃浠跺叏灞€閰嶇疆锛岄」鐩?浼氳瘽灞備笉鏀寔锛夛細

```yaml
routingRules:
  - taskType: docs
    label: 鏂囨。
    keywords: [鏂囨。, 鎵嬪唽, 鏍″]
    roleKeywords: [鏂囨。, writer, 鏂囦功]
  # - taskType: review
  #   keywords: [瀹℃煡, review]
  #   roleIds: [role-wukong]   # 涔熷彲鐩存帴閽夋瑙掕壊 ID
```

> 鑷畾涔夎〃鏄?*鏁翠綋鏇挎崲**鑰岄潪杩藉姞锛涢潪娉曟潯鐩紙缂?`taskType` 鎴?`keywords`锛変細琚烦杩囥€?
> 鍙厤 `docs` 鏃讹紝鍏跺畠浠诲姟绫诲瀷涓嶅啀鍛戒腑鍐呯疆瑙勫垯锛屽彧鑳借蛋 `defaultRoleId` 鎴栨姤閿欌€斺€旇繖鏄湁鎰忎负涔嬶紝閬垮厤鈥滈厤缃簡涓€鍗婂嵈鍋峰伔鐢ㄥ唴缃〃鈥濄€?

## 2. `channels`锛堥€氶亾瀹炰緥琛級

涓€琛?= 涓€涓凡閰嶇疆濂界殑 provider銆?*妯″瀷/寮哄害鍐欏湪杩欓噷**锛屽洜涓哄涓荤殑瀛愪换鍔″惎鍔?spec 涓嶆帴鏀惰繖涓や釜瀛楁銆?

| 瀛楁 | 绫诲瀷 | 蹇呭～ | 璇存槑 |
| --- | --- | --- | --- |
| `channelId` | string | 鉁?| 瀹炰緥 ID锛岃鑹查€氳繃 `channel.channelId` 寮曠敤 |
| `kind` | `in-process` \| `acp-cli` \| `codex` \| `claude-code` | | 閫氶亾绫诲瀷 |
| `provider` | string | | provider 鍚嶏紙`spawn` / `acp` / `codex` / `claude-code`锛夛紝鐪佺暐鏃舵寜 kind 鎺ㄦ柇 |
| `model` | string | | 璇?provider 琛屽疄闄呬娇鐢ㄧ殑妯″瀷 |
| `reasoning` | string | | 璇?provider 琛屽疄闄呯殑鎬濊€冨己搴?|
| `description` | string | | 浜虹被鍙璇存槑 |

**涓轰粈涔堣杩欏眰**锛圖D7 鏂规 B锛夛細瑙掕壊涓嶈兘鍑┖鎸囧畾妯″瀷銆傝鑹茬殑澹版槑蹇呴』涓庢墍寮曠敤瀹炰緥涓€鑷达紝鍚﹀垯娲惧崟琚嫆锛坄MODEL_UNSUPPORTED`锛夆€斺€旀垜浠畞鍙姤閿欙紝涔熶笉鍋?閰嶇疆鎴愬姛銆佹墽琛屾病閲囩敤"銆?

> **鏈」鐩笉鎻愪緵鍙閫氶亾**锛氬涓?subagent 鍚姩 spec 娌℃湁鏉冮檺瀛楁锛屽仛涓嶅埌缁濆鍙銆傚洜姝よ繖閲屾病鏈?`permissionPreset`锛岃鑹蹭笂涔熸病鏈夛紱涓嶈鍐嶅疄鐜帮紙2026-11-11 鐢ㄦ埛鍐崇瓥锛夈€?

## 3. `roles`锛堣鑹茶〃锛?

| 瀛楁 | 绫诲瀷 | 榛樿 | 璇存槑 |
| --- | --- | --- | --- |
| `roleId` | string | 鈥?| 绋冲畾 ID锛宍^role-[a-z0-9][a-z0-9-]*$`锛屾敼鍚嶄笉鍙?|
| `name` | string | 鈥?| 鏄剧ず鍚嶏紝鍚屾椂鍙備笌瑙ｆ瀽 |
| `aliases` | string[] | `[]` | 鍒悕锛涜法瑙掕壊鍞竴锛堝ぇ灏忓啓/绌虹櫧涓嶆晱鎰燂級 |
| `description` | string | `''` | 鑱岃矗璇存槑 |
| `channel.kind` | 鏋氫妇 | `in-process` | 閫氶亾绫诲瀷 |
| `channel.channelId` | string | | 寮曠敤閫氶亾瀹炰緥 |
| `channel.model` / `channel.reasoning` | string | | 澹版槑鏈熸湜鍊硷紝蹇呴』涓庡疄渚嬩竴鑷?|
| `enabled` | boolean | `true` | 鍋滅敤鍚庝笉寰楁淳鍗?|
| `fallbackRoleId` | string | | 棰勭暀锛堢涓€鐗堝彧鎻愮ず锛屼笉鑷姩鎺ユ浛锛?|
| `timeoutMs` | number | `1800000` | 鍗曟娲惧崟瓒呮椂 |

## 4. 椤圭洰绾ч厤缃?`.meetingstone.json`

鏀惧湪**椤圭洰鏍?*锛堝彇 `exec.agent.session.header.cwd`锛夈€?

```json
{
  "version": 1,
  "defaultRoleId": "role-sashi",
  "roles": [{ "roleId": "role-scout", "name": "鏂ュ€?, "channel": { "kind": "in-process" } }],
  "roleOverrides": { "role-sashi": { "description": "鏈」鐩噷璐熻矗涓诲姏寮€鍙? } },
  "dispatchNotes": "鍙敼 src/锛涘姩 docs/ 鍓嶅厛闂€?,
  "projectRules": ["鏈粡纭涓嶅緱淇敼鏁版嵁搴撹縼绉绘枃浠?]
}
```

**鍚堝苟瑙勫垯**

1. 椤圭洰 > 鍏ㄥ眬锛坄roleOverrides` 鎸?roleId 鎵撹ˉ涓侊紱`roles` 閲屽悓 roleId 涔熸槸瑕嗙洊锛夈€?
2. `channel` 瑕嗙洊鏄?*瀛楁绾у悎骞?*锛涗絾妯″瀷/寮哄害浠嶈涓庡疄渚嬩竴鑷淬€?
3. 鏂囦欢鍧忎簡锛圝SON 闈炴硶銆佺増鏈笉璁よ瘑銆佸瓧娈电被鍨嬮敊锛夆啋 **闄嶇骇涓虹┖閰嶇疆 + 鎶婇敊璇毚闇插湪宸ュ叿杩斿洖閲?*锛岀粷涓嶆墦鏂淳鍗曢摼璺€?

> 椤圭洰绾ч厤缃?*涓嶆彁渚?`limits`**锛氬悓椤圭洰涓茶寮€鍏?`serializeWrites` 鍙湪鎻掍欢鍏ㄥ眬閰嶇疆锛埪?锛夐噷鐢熸晥锛岄」鐩枃浠堕噷鍐?`limits` 浼氭寜鏈煡瀛楁蹇界暐锛屼笉鎶ラ敊銆佷笉闃绘柇娲惧崟銆?
> `permissionPreset` 宸查殢鍙閫氶亾绉婚櫎锛涙棫閰嶇疆閲屽啓浜嗕篃浼氳蹇界暐锛屼笉鎶ラ敊銆佷笉闃绘柇娲惧崟銆?

### 4.1 涓夊眰缁ф壙锛坓lobal 鈫?project 鈫?session锛?

鐢熸晥閰嶇疆鎸?**鍏ㄥ眬 鈫?椤圭洰 鈫?浼氳瘽** 鍚堝苟锛屽悗鑰呰鐩栧墠鑰咃紱鍙奖鍝嶅悇鑷殑浣滅敤鍩燂細

| 灞?| 浣嶇疆 | 浣滅敤鍩?|
| --- | --- | --- |
| global | profile `cordis.patch.yml` 鐨?`meetingstone` 琛?| 鎵€鏈夐」鐩?浼氳瘽 |
| project | `<椤圭洰鏍?/.meetingstone.json` | 褰撳墠椤圭洰 |
| session | `<椤圭洰鏍?/.meetingstone/sessions/<sessionId>.json` | **浠呭綋鍓嶅璇?*锛坄exec.agent.session.id`锛?|

鍚堝苟瑙勫垯锛坄src/session/config.js` 鐨?`resolveEffectiveConfig`锛夛細

1. 鍚?`roleId` 鎸夊瓧娈佃鐩栵紱`channel` 涔熸槸瀛楁绾у悎骞讹紙鍙啓 `model` 涓嶄細鎶?`kind` / `provider` 鎶规帀锛夈€?
2. `aliases` 鏄?*鏁翠綋鏇挎崲**锛屼笉鏄拷鍔狅紱`alias` 鏄崟鍊?鏁扮粍鐨勭畝鍐欍€?
3. **鍙繚瀛樺樊寮?*锛氫細璇濆€间笌缁ф壙鍊肩浉鍚?鈫?璇ラ敭涓嶈惤鐩橈紱鎶婁竴涓瓧娈垫敼鍥炵户鎵垮€?鈫?鍒犻櫎鏃ц鐩栵紙鎭㈠缁ф壙锛夈€?
4. 鏈煡瀛楁**鎷掔粷骞舵姤閿?*锛堥《灞傘€佽鑹层€乣channel` 涓夊眰閮芥寜鐧藉悕鍗曟牎楠岋級锛屼笉浼氶潤榛樼敓鏁堛€?
5. 浼氳瘽灞傚彧鏀归厤缃紝涓嶆敼鍙橀」鐩殧绂伙細涓嶅悓 `sessionId` 鐢ㄤ笉鍚屾枃浠讹紝浜掍笉褰卞搷銆?
6. `resolveEffectiveConfig({ global, project, session })` 杩斿洖 `{ effective, sources, errors }`锛?
   `sources.roles[roleId]` 缁欏嚭 `layer` 涓庨€愬瓧娈垫潵婧愶紙`global` / `project` / `session` / `default`锛夛紝
   `sources.defaultRoleId` / `sources.dispatchNotes` / `sources.projectRules` 鍚屾牱鏍囨敞锛屼緵 UI 鏄剧ず"缁ф壙/瑕嗙洊"銆?
7. 鍒悕鍐茬獊涓嶅湪杩欓噷鍒ゅ畾锛氳皟鐢ㄦ柟鍦?*鏈€缁堢敓鏁堣鑹茶〃**涓婂缓娉ㄥ唽琛?
   锛坄createRegistry({ globalRoles: effective.roles })`锛夛紝鍐茬獊鐢辨敞鍐岃〃鐨?`errors` 缁熶竴鎶ュ憡銆?

浼氳瘽瑕嗙洊鏂囦欢绀轰緥锛坄.meetingstone/sessions/<sessionId>.json`锛宍.meetingstone/` 宸插湪 `.gitignore`锛夛細

```json
{
  "version": 1,
  "roleOverrides": {
    "role-sashi": {
      "alias": ["SSS"],
      "description": "鏈璇濋噷璐熻矗瀹炵幇",
      "prompt": "鏈璇濈殑棰濆瑙勫垯",
      "channel": { "cli": "acp", "model": "m-2", "reasoning": "high" }
    }
  },
  "roles": [{ "roleId": "role-temp", "name": "涓存椂", "channel": { "kind": "in-process" } }],
  "defaultRoleId": "role-sashi",
  "dispatchNotes": "鏈璇濅紭鍏堢煭鍥炲",
  "projectRules": ["鏈璇濆彧鏀?src/"]
}
```

瀛楁鐧藉悕鍗曪細

| 灞?| 鍏佽瀛楁 |
| --- | --- |
| 椤跺眰 | `version` / `roles` / `roleOverrides` / `defaultRoleId` / `dispatchNotes` / `projectRules` |
| 瑙掕壊 | `roleId` / `name` / `alias`锛堟垨 `aliases`锛? `description` / `prompt` / `channel` / `enabled` / `fallbackRoleId` / `timeoutMs` |
| 閫氶亾 | `kind` / `channelId` / `provider` / `cli` / `model` / `reasoning` |

鏂板/鏀瑰瓧娈电殑瀹夸富渚?API锛坄src/session/store.js`锛屾棤 UI锛夛細

- `store.setOverride(projectRoot, sessionId, { roleId, patch, inherited })`锛氬彧鍐欏樊寮傦紱
  绛変簬缁ф壙鍊肩殑瀛楁浼氫粠鏃ц鐩栭噷鍒犻櫎銆?
- `store.clearOverride(projectRoot, sessionId, { roleId, field })`锛歚field` 鐪佺暐 = 鎭㈠鏁翠釜瑙掕壊锛?
  鏀寔 `channel.model`锛屼篃鎺ュ彈 `model` / `reasoning` 绛夐€氶亾绠€鍐欍€?
- `store.get(projectRoot, sessionId)`锛氭案涓嶆姏寮傚父锛涙枃浠朵笉瀛樺湪 鈫?绌洪厤缃紝鍧?JSON / 鐗堟湰涓嶈璇?鈫?
  绌洪厤缃?+ `SESSION_CONFIG_INVALID_JSON` / `SESSION_CONFIG_UNSUPPORTED_VERSION`銆?

> **涓轰粈涔堜笉鐢ㄥ涓荤殑 session 绾у瓨鍌?*锛?026-11-11 鏌?0.2.2-rc.1 瀹為檯鍖咃級锛?
> `@deepseek-ai/dsh-session` 鐨?`SessionHeader` 鏄垱寤烘椂娣卞喕缁撶殑鍏冩暟鎹紙浠?`cwd` 绛夛級锛?
> 娌℃湁鎻掍欢鍙啓鐨?per-session KV锛涗細璇濇棩蹇楁槸浜嬩欢婧簮锛宍appendPluginRecord()` 鏄庣‘鍙厑璁?
> 浠撳簱鍐?experimental 鍖呰皟鐢ㄣ€俙@deepseek-ai/dsh-storage-domain` 闇€瑕?`defineDomain` + zod锛?
> 鏈彃浠舵槸闆朵緷璧栫殑锛屼笖璇ユ湇鍔′笉鏄墍鏈?composition 閮芥寕杞姐€傛晠閫€鍖栦负椤圭洰鍐呮枃浠躲€?
>
> 灞€闄愶細鏂囦欢涓嶉殢瀹夸富浼氳瘽褰掓。/鍒犻櫎鑰屾竻鐞嗭紱鎹㈤」鐩矾寰勫悗鐪嬩笉鍒版棫瑕嗙洊锛涘杩涚▼鍚屾椂鍐欏悓涓€
> session 鏂囦欢娌℃湁璺ㄨ繘绋嬮攣锛堟渶鍚庡啓鍏ヨ€呰儨鍑猴級銆?

## 5. 瑙ｆ瀽涓庢牎楠?

| 鍦烘櫙 | 琛屼负 |
| --- | --- |
| 鏈寚瀹?`role` 涓旀湭寮€ `autoRoute`锛堟垨 `role` 涓嶆槸瀛楃涓诧級 | `ROLE_REQUIRED`锛堜笉浼氶殣寮忎娇鐢?`defaultRoleId`锛?|
| 寮€浜?`autoRoute` 浣嗘病鏈?`enabled + available` 鐨勮鑹诧紱鎴栦换鍔＄被鍨嬫棤鍖归厤瑙掕壊涓?`defaultRoleId` 鏈厤缃?涓嶅彲鐢?| `AUTO_ROUTE_FAILED`锛宍message` 璇存槑澶辫触鍦ㄢ€滄棤鍙敤瑙掕壊鈥濊繕鏄€滄棤鍖归厤瑙掕壊/鍏滃簳鈥?|
| 鍚嶅瓧/鍒悕鍐茬獊 | 鍐茬獊 token 涓嶅弬涓庤В鏋愶紱瑙掕壊浠嶅彲鐢?`roleId`锛沗list_roles` 鐨?`errors` 閲岀粰 `ALIAS_CONFLICT` |
| 娲惧崟鍒版涔夊悕瀛?| `ROLE_AMBIGUOUS`锛屾彁绀洪噷鍒楀嚭鍙€?roleId |
| 娲惧崟鍒板仠鐢ㄨ鑹?| `ROLE_DISABLED` |
| provider 鏈敞鍐?| `PROVIDER_UNAVAILABLE`锛岄檮甯﹀師鍥?|
| 妯″瀷涓庡疄渚嬩笉涓€鑷?| `MODEL_UNSUPPORTED`锛岀粰鍑哄弻鏂瑰彇鍊?|
| `cwd` 瓒婂嚭椤圭洰鏍?| `PATH_OUTSIDE_PROJECT` |
| 鎷夸笉鍒伴」鐩牴鍗存寚瀹?`cwd` | `PROJECT_ROOT_UNKNOWN` |
| 鍚岄」鐩凡鏈変换鍔★紙`isolation:none` + `serializeWrites`锛?| `WRITE_CONFLICT`锛堟纭€т繚鎶わ紝涓嶆槸棰濆害锛?|
| 鍚岄」鐩凡鏈夋湭闅旂浠诲姟锛屾垨闅旂浠诲姟閬囧埌鏈殧绂讳换鍔?| `WRITE_CONFLICT`锛堜笉寰楁贩璺戯級 |
| 鏈彃浠跺苟琛屽啓浠诲姟杈惧叏灞€涓婇檺 | `WRITE_LIMIT_TOTAL`锛堢珛鍗虫嫆缁濓紝涓嶆帓闃燂紝绋嶅悗閲嶈瘯锛?|
| 瀹夸富瀛?Agent 鍏变韩姹犲凡婊★紙`maxActiveSubagents` 榛樿 8锛?| `ACTIVATION_LIMIT_REACHED`锛堝師鏍烽€忎紶锛屼笉鎺掗槦锛岀瓑鐜版湁浠诲姟缁撴潫锛?|
| 璇锋眰闅旂浣嗗伐浣滄爲鏈嶅姟缂哄け | `WORKTREE_UNAVAILABLE` |
| 椤圭洰鏍逛笉鏄?git 宸ヤ綔鍖?| `WORKTREE_NOT_GIT_REPOSITORY` |
| `base` 鏃犳硶瑙ｆ瀽涓?commit | `WORKTREE_BASE_INVALID` |
| 宸ヤ綔鏍戣矾寰勫凡瀛樺湪/宸茶 git 鐧昏 | `WORKTREE_PATH_EXISTS` |
| `meetingstone/<operationId>` 鍒嗘敮宸插瓨鍦?| `WORKTREE_BRANCH_EXISTS` |
| 鍏朵粬 git 澶辫触 | `WORKTREE_GIT_FAILED` |
| git 鍛戒护瓒呮椂锛堝缓鏍?30s / 璁＄畻鏀瑰姩 10s锛?| `WORKTREE_TIMEOUT` |
| 宸ヤ綔鏍戝疄闄呰矾寰勯€冨嚭椤圭洰鏍?| `WORKTREE_PATH_OUTSIDE` |
| `isolation` 涓嶆槸 `none`/`worktree` | `INVALID_ISOLATION` |
| 缁撴瀯鍖?TaskSpec 缂哄叧閿瓧娈碉紙`title`锛涙垨澹版槑浜?`scope` 鍗存病鏈?`acceptance`锛涙垨瀛楁绫诲瀷閿欒锛?| `TASKSPEC_INVALID`锛宍message` 璇存槑缂轰粈涔堬紝`fields` 鍒楀嚭瀛楁鍚?|
| `meetingstone_get_run_artifact` 鎵句笉鍒拌褰?| `NOT_FOUND` |
| 璁板綍鏂囦欢涓嶆槸鍚堟硶 JSON | `CORRUPT` |
| `lineFrom/lineTo` 涓?`headBytes/tailBytes` 鍚屾椂浣跨敤銆佹垨鑼冨洿闈炴硶 | `INVALID_RANGE` |
| `meetingstone_wait` 鐨?`childIds` 涓嶆槸闈炵┖瀛楃涓叉暟缁?| `INVALID_CHILD_IDS` |
| `meetingstone_wait` 鐨?`timeoutMs` 涓嶆槸姝ｆ暟 | `INVALID_TIMEOUT` |
| `meetingstone_wait` 鐨?childId 鍦ㄦ湰杩涚▼鏌ヤ笉鍒帮紙鍚?DSH 閲嶅惎鍓嶇殑浠诲姟锛?| `UNKNOWN_CHILD`锛氱珛鍗宠繑鍥烇紝涓嶉樆濉烇紝`unknownChildIds` 鍒楀嚭 |
| 璁板綍鏂囦欢瓒呰繃璇诲彇涓婇檺 | `TOO_LARGE` |
| 鍙栨秷/鍗歌浇鏃跺涓?`dispose()` 瓒呮椂 | `ADAPTER_DISPOSE_TIMEOUT`锛氬啓缁堟€侊紙`stopConfirmed:false`锛夊苟**淇濈暀**骞跺彂妲戒綅/闅旂浜掓枼锛岀瓑 activation.result 钀藉畾鍚庤嚜鍔ㄩ噴鏀?|
| 鍙栨秷/鍗歌浇鏃跺涓?`dispose()` 鎶涢敊 | `ADAPTER_DISPOSE_FAILED`锛氬啓缁堟€侊紙`stopConfirmed:false`锛夊苟**淇濈暀**骞跺彂妲戒綅/闅旂浜掓枼锛岀瓑 activation.result 钀藉畾鍚庤嚜鍔ㄩ噴鏀?|
| 鎻掍欢宸插嵏杞芥椂浠嶆湁鍚姩璇锋眰 | `ADAPTER_DISPOSED`锛氭嫆缁濆惎鍔紱鍚姩涓殑 activation 鍦ㄥ嵏杞藉悗杩斿洖鏃跺厛 dispose锛岀‘璁ゅ仠姝㈡墠閲婃斁鍗犱綅妲戒綅銆俤ispose 鎶涢敊/瓒呮椂鏃?*淇濈暀鍙ユ焺涓庢Ы浣?*锛屽啓 `interrupted + stopConfirmed:false + error` 缁堟€侊紝绛?result 钀藉畾鍚庡啀閲婃斁锛涢敊璇爜鍘熸牱閫忎紶锛屼笉褰掑叆 `ADAPTER_FAILED` |

## 6. 鐢熷懡鍛ㄦ湡銆乺untimeId 涓?interrupted

- 姣忔鎻掍欢鍚姩鐢熸垚涓€涓?`runtimeId`锛屽啓杩涙瘡涓€鏉¤惤鐩樿褰曪紙`.meetingstone/runs/<childId>.json`锛夈€?
- **鍙栨秷椤哄簭**锛氬厛 `abort` 鈫?`await activation.dispose()`锛堥粯璁ゆ渶澶氱瓑 5 绉掞級鈫?**纭鍋滄鍚?*鎵嶉噴鏀惧苟鍙戞Ы浣嶃€?
  dispose 瓒呮椂鎴栨姏閿欐椂妲戒綅涓庨殧绂讳簰鏂ヤ繚鐣欙紝鍏堝啓 `cancelled + stopConfirmed:false` 缁堟€侊紱绛?
  `activation.result` 钀藉畾锛堝彲楠岃瘉鐨勫仠姝㈣瘉鎹級鍚?*鍥炲～**锛氬啀鍐欎竴鏉＄粓鎬侊紝鎶?`stopConfirmed` 鏀逛负 `true`銆?
  `diagnostic` 杩藉姞 `late settlement`锛宍status` 淇濇寔 `cancelled` 涓嶈鏀瑰啓鎴?`completed`锛岃繖鏃舵墠鑷姩閲婃斁妲戒綅銆?
  閲嶅鍙栨秷澶嶇敤鍚屼竴涓敹灏?promise銆?
- **钀界洏椤哄簭**锛氬悓涓€ `childId` 鐨勫啓鍏ユ寜 FIFO 涓茶锛宍running` 涓€瀹氬厛浜庣粓鎬佽惤鍦帮紝缁堟€佷笉浼氳瑕嗙洊銆?
- **閲嶅惎鍚庣殑鍋?running**锛氳鍙栨椂鑻?`status === 'running'` 涓?`runtimeId` 涓嶆槸褰撳墠杩涚▼鐨勶紝鎶曞奖涓?
  `status: 'interrupted'` + `interrupted: true`锛涘彧鏀硅繑鍥炲€硷紝涓嶅洖鍐欑鐩樸€?
- **鎻掍欢鍗歌浇**锛氬鍐呭瓨涓粛瀛樻椿鐨勪换鍔″啓 `interrupted` 缁堟€侊紙`stopReason: 'plugin-disposed'`锛夛紝
  涓嶄細鍦ㄧ鐩樼暀涓嬪亣 `running`銆傛瘡涓彞鏌勭嫭绔嬫敹灏撅細涓€涓?`dispose` 闃诲涓嶄細鎷栦綇鍏朵粬鍙ユ焺鐨勭粓鎬併€?
  `dispose` 鏈‘璁ょ殑浠诲姟淇濈暀妲戒綅骞惰 `stopConfirmed:false`锛涚瓑寰呮湡闂?result 宸茶惤瀹氱殑浠诲姟
  涔熺収甯稿啓缁堟€侊紝骞惰 `stopConfirmed:true`銆?
  "鍚姩涓?锛坄startActivation` 灏氭湭杩斿洖锛夌殑 activation 浼氳鍐荤粨锛涜繑鍥炲悗纭 dispose 鎴愬姛鎵嶉噴鏀?
  鍗犱綅妲戒綅锛岀粷涓嶅湪鍗歌浇鍚庣櫥璁颁负瀛樻椿浠诲姟銆?
- **宸ヤ綔鏍戣褰?*锛氱粓鎬佽褰曞寘鍚?`worktree: { path, branch, baseSha, repositoryRoot, operationId }`銆?
  `changedFiles`銆乣changedFilesUnknown`銆乣changedFilesTruncated`銆乣changedFilesTotal`銆乣stopConfirmed`銆?
  `changedFiles` 鏈€澶氬啓 5000 鏉★紙鍙︽湁 2MB 瀛楄妭棰勭畻锛夛紝瓒呭嚭鏃?`changedFilesTruncated:true` 骞朵繚鐣欐€绘暟銆?
  浣撶Н闂稿厹搴曟椂**鍚屾椂**瑁佸壀 `changedFiles` 涓?`overlapWarnings`锛岄伩鍏嶅啓鍑鸿嚜宸辫涓嶅洖鐨勮褰曘€?
  甯?`worktree` 鐨勮褰?*涓嶅弬涓?* 100 鏉?30 澶╄嚜鍔ㄦ竻鐞嗭紙淇濇姢鏈悎骞舵垚鏋滅殑鍏冩暟鎹級锛?
  瓒呭ぇ鎴栨棤娉曡В鏋愮殑璁板綍鍚屾牱鎸?fail-safe **涓嶅垹闄?*銆傚伐浣滄爲/鍒嗘敮鏈韩涓€寰嬩笉鑷姩鍒犻櫎銆?
- **閲嶅彔棰勮**锛歚get_task` / `list_runs` 杩斿洖 `overlapWarnings: [{ childId, files }]`锛?
  缁堟€佸啓鍏ユ椂鍦?*椤圭洰绾у紓姝ヤ簰鏂?*鍐呰绠楀苟鍥炲啓锛氬啓褰撳墠璁板綍鍚庯紝鎶婁氦闆嗘湁鐣屽湴鍥炲啓鍒板弬涓庝氦闆嗙殑
  鍘嗗彶璁板綍锛屽洜姝ゅ苟鍙戠粨鏉熼『搴忎换鎰忥紝鍙屾柟鍘熷 JSON 閮藉惈浜ら泦銆?
  `overlapWarnings` 姣忓鏈€澶?50 涓枃浠躲€佹暣涓瓧娈垫渶澶?64KB锛圝SON 杞箟鍚庯級锛岃秴闄愭椂鍐?
  `overlapTruncated:true` / `overlapTotal:<鍘熷鏂囦欢鎬绘暟>`銆?
  `changedFilesUnknown: true` 鐨勮褰曚笉鍙備笌姣旇緝锛屼絾浼氬湪缁撴灉閲屾爣娉ㄦ湭鐭ャ€?
- **澶辫触涓婁笅鏂?*锛歚WORKTREE_*` 澶辫触缁撴灉淇濈暀 `path` / `branch` / `phase` / `residualPath`锛?
  甯﹀伐浣滄爲鐨勫惎鍔ㄥけ璐ュ悓鏍蜂繚鐣欏伐浣滄爲璺緞涓庡垎鏀紝渚夸簬浜哄伐瀹氫綅娈嬬暀銆?

## 7. 宸ュ叿杩斿洖涓庝换鍔″绾︼紙Token 浼樺寲锛?026-11-11锛?

浼氳瘽涓婁笅鏂囨槸鏈夐檺棰勭畻锛屼互涓嬮粯璁ゅ€兼寜瀹¤缁撹鏀剁揣锛涢渶瑕佸畬鏁村唴瀹规椂蹇呴』鏄惧紡绱㈠彇銆?

| 宸ュ叿 | 榛樿杩斿洖 | 瀹屾暣/璇︾粏妯″紡 |

> **Token 口径**：Subagents 面板的 `tok` = `uncachedInput + output + cacheRead + cacheWrite`，按整条持久日志累计；fork 会话包含父会话历史（`154M / 4 秒` 即此），耗时只算子会话自身。**不可用于成本、额度或子 Agent 归属核算**；替代口径（账本字节、`ownEvents` 截断、四桶分价、Provider 账单）见 [`docs/audit/token-stats.md`](audit/token-stats.md)。

| 工具 | 默认返回 | 完整/详细模式 |
| --- | --- | --- |
| `meetingstone_get_task` | `status` / `stopReason` / `resultBytes` / `jobId` / `recordPath`锛涙湁缁撴瀯鍖?`summary` 鏃跺彧鍥?summary/resultStatus/openIssues/handoff锛坄resultOmitted:true`锛夛紝鍚﹀垯鍥炵粨鏋滈 1KiB + 鏈?512B | `full:true` 杩斿洖瀹屾暣 `result`锛沗output` 涓?`result` 鐩稿悓鏃跺彧鍥炰竴浠斤紙瀛楁鍚嶇粺涓€涓?`result`锛?|
| `meetingstone_get_run_artifact` | 瀹屾暣缁撴灉鏂囨湰锛坄.meetingstone/runs/<childId>.json` 鐨?`result`锛?| 鐢?`headBytes`/`tailBytes` 鍙栭灏撅紝鎴?`lineFrom`/`lineTo`锛? 璧枫€佸惈绔偣锛夊彇琛岃寖鍥?|
| `meetingstone_dispatch` | 鎴愬姛鍙洖 `ok` / `taskRef`锛坄childId`銆乣name`銆乣provider`銆乣jobId`锛? `roleId` / `roleName` / `isolation` / `routing`锛坄roleId` + 鑷姩璺敱鏃剁殑 `reason`锛?| 瑙掕壊鍏ㄩ噺銆乸rompt銆佸伐浣滄爲缁嗚妭涓€寰嬩笉鍥烇紱闇€瑕佹椂鏌?`meetingstone_list_runs` |
| `meetingstone_list_runs` | 璁板綍绱㈠紩锛歚title` / `status` / `resultStatus` / `summaryPreview` / `resultBytes` 绛?| 闇€瑕佹鏂囩敤 `meetingstone_get_task` 鎴?`meetingstone_get_run_artifact` |
| `meetingstone_list_roles` | `roleId` / `name` / `aliases` / `enabled` / `availability` | `verbose:true` 杩藉姞 `description` / `channel` / `model` / `hasPrompt` / `source` |
| `meetingstone_wait` | 姣忎釜浠诲姟鐨?`childId` / `status` / `stopReason` / `resultBytes` / `summary?` / `timedOut` | 瓒呮椂鏈畬鎴愮殑浠诲姟鏍?`status:'running'`銆乣timedOut:true`锛涙湭鐭?`childId` 绔嬪嵆杩斿洖 `UNKNOWN_CHILD` |

- `meetingstone_wait` 鐢ㄤ簬**鏀跺彛**锛堜竴娆＄瓑涓€缁勪换鍔″叏閮ㄥ埌杈剧粓鎬侊級锛屼笉瑕侀珮棰戣皟鐢ㄣ€佷笉瑕佹嬁瀹冭疆璇細榛樿鏈€澶氱瓑 300000ms銆佷笂闄?600000ms锛涘凡瀹屾垚鐨勭珛鍗宠繑鍥烇紝鏈畬鎴愮殑鍙瓑瀹夸富缁撶畻閫氱煡锛堜笉蹇欑瓑锛夛紱鍚屼竴浠诲姟琚娆?wait 澶嶇敤鍚屼竴鐩戝惉銆傚彧璁ゆ湰杩涚▼鍐呭瓨璁板綍锛孌SH 閲嶅惎鍓嶇殑浠诲姟瑙嗕负鏈煡銆?

- `meetingstone_get_task` 鐨?`recordPath` 鎸囧悜 `.meetingstone/runs/<childId>.json`锛沗resultBytes` 鏄師濮嬬粨鏋滃瓧鑺傛暟锛堜笉鏄埅鏂悗闀垮害锛夈€?
- 涓婁笅鏂囬噸鏀句笂闄愪粠 64KiB 鏀剁揣鍒?**16KiB**锛堝ご 12KiB + 灏?4KiB锛夈€傚甫 `continuesFrom` 鐨勬淳鍗曚細鍦ㄨ惤鐩樿褰曢噷鍐?`continuationBytes`锛堟湰娆″疄闄呮敞鍏ョ殑閲嶆斁鍧楀瓧鑺傛暟锛夛紱娌℃湁閲嶆斁鍒?*鐪佺暐璇ュ瓧娈?*銆?

### 7.1 TaskSpec（结构化任务简报，P0-B）

协议与示例见 [task-protocol.md](task-protocol.md)。`meetingstone_dispatch` 仍接受**纯字符串** `role + task`（旧调用不受影响）；以下字段均可选，传任一即进入结构化模式。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `title` | string | 短任务名；**使用任一结构化字段时必填**（Jobs / list_runs 展示） |
| `objective` | string | 要达成的结果；省略时任务正文即目标 |
| `scope` | `{ include: string[], exclude: string[] }` | 范围与边界 |
| `acceptance` | string[] | 验收标准；**声明了 scope 时必填** |
| `evidence` | string[] | 需要提交的证据 / 文件 / 测试 |
| `contextRefs` | string[] | 上下文包或文件引用 |
| `roleHint` | string | 建议角色/能力提示（不改变本次 `role` 路由） |
| `outputBudget` | `{ summaryTokens?: number, notes?: string }` | 摘要与产物预算；Provider 不支持硬上限时只作为指令 |
| `contextPack` | 见 §7.2 | 最小上下文 |

> `evidence` / `contextRefs` / `contextPack` / `outputBudget` / `roleHint` 属于**可选增强**，不传不影响调用。

校验规则（`TASKSPEC_INVALID`，完整清单见 [task-protocol.md §5](task-protocol.md#5-校验边界)）：

- 结构化模式缺 `title` → 拒绝；
- 声明了 `scope`（include/exclude 非空）却没有 `acceptance` → 拒绝；
- 关键字段类型错误（如 `acceptance` 传字符串、`contextPack` 传数组）→ 拒绝；
- 简单查询只传 `task`，或只带 `title`，一律放行；不强制 `scope`/`evidence`。

### 7.2 ContextPack（最小必要上下文）

形状为 `{ knownFacts[], files[], priorResults[{ summary, artifactRef }], doNotRepeat[] }`，示例与省略规则见 [task-protocol.md](task-protocol.md)。`doNotRepeat` 是保护字段，落盘摘要时原样保留。

- TaskSpec + ContextPack 会渲染成**结构化文本块**，插在人设之后、任务正文之前；同时附带「不要重复探索 / 不要复述长文」约束。
- 不新增任何 AI 调用；不传 `taskSpec`/`contextPack` 时提示词与旧版一致（只多出固定的输出契约，见 §7.3）。
- 落盘记录里的 `taskSpec` / `contextPack` 是**截断后的摘要**（列表 ≤10 条、单条 ≤200 字符），用于 `list_runs` / `get_task` 展示标题。

### 7.3 缁撴瀯鍖栫粨鏋滃绾︼紙P0-C锛?

娲惧崟鎻愮ず璇嶆湯灏惧浐瀹氬寘鍚緭鍑哄绾︼紝瑕佹眰瀛?Agent 鍦ㄥ洖澶嶆渶鍚庣粰鍑?JSON锛?

```json
{
  "status": "completed | partial | blocked | failed",
  "summary": "缁撹鎽樿锛堢害 300鈥?00 token锛?,
  "evidence": [{ "file": "src/auth/callback.ts", "line": 84, "finding": "缂哄皯绉熸埛褰掑睘鏍￠獙" }],
  "artifacts": [".meetingstone/runs/task-123/review.md"],
  "changedFiles": [],
  "tests": ["闈欐€佹鏌ュ畬鎴愶紱鏈繍琛岄泦鎴愭祴璇?],
  "openIssues": ["闇€瑕佺‘璁ゆ棫绉熸埛鍏煎閫昏緫"],
  "nextAction": "浜ょ敱娌欏儳淇鍚庡啀鐢辨偀绌哄鏍?
}
```

瑙ｆ瀽瑙勫垯锛坄src/result-contract.js`锛夛細

- 鏀寔鏁存 JSON銆乣``json 浠ｇ爜鍧椼€佹枃鏈腑绗竴涓钩琛＄殑 `{...}`锛?
- 鎻愬彇涓嶅埌锛堢函鏂囨湰锛夆啋 `structuredResult:false`锛宍summary` = 鍘熸枃锛涘潖 JSON 鍚屾牱閫€鍥炲師鏂囷紱
- 瀛?Agent 鑷姤鐨?`changedFiles` 钀藉埌 `reportedChangedFiles`锛?*涓嶈鐩?*璁板綍閲岀敱 git 璁＄畻鐨?`changedFiles`锛堥噸鍙犳娴嬩緷璧栧悗鑰咃級锛?
- 璁板綍鏂板锛歚summary`锛堚墹8KiB锛岃秴鍑烘寜棣栧熬鎴柇锛屽甫 `summaryBytes`/`summaryTruncated`锛夈€乣resultStatus`銆乣evidence`銆乣artifacts`銆乣resultTests`銆乣openIssues`銆乣nextAction`銆乣handoff`锛?
- 瀹屾暣 `result` 浠嶇劧钀界洏锛堜笂闄?256KiB锛夛紝鍙敤 `full:true` 鎴?`meetingstone_get_run_artifact` 鍙栧洖銆?

`handoff` 瀛楁锛堢粨璁?璇佹嵁/浜х墿/鏈喅/涓嬩竴姝ワ級鐢辫В鏋愮粨鏋滅敓鎴愶紝妯℃澘瑙?[handoff.md](handoff.md)銆?；协议总纲见 [task-protocol.md](task-protocol.md)。

### 7.4 鎸夐渶璇诲彇瀹屾暣缁撴灉

`meetingstone_get_run_artifact` 鍙椤圭洰鍐?`.meetingstone/runs/<childId>.json`锛?

| 鍙傛暟 | 璇存槑 |
| --- | --- |
| `childId` | 蹇呭～锛宍meetingstone_dispatch` 杩斿洖鐨?`taskRef.childId` |
| `headBytes` / `tailBytes` | 鍙栭灏惧瓧鑺傜獥鍙ｏ紱涓よ€呬笉鑳戒笌琛屽弬鏁板悓鏃朵娇鐢?|
| `lineFrom` / `lineTo` | 1 璧枫€佸惈绔偣锛涚渷鐣?`lineTo` 璇诲埌鏈熬 |

杩斿洖 `content`锛堟枃鏈級銆乣bytes`锛堟湰娆¤繑鍥炲瓧鑺傦級銆乣resultBytes`锛堝師濮嬪瓧鑺傦級銆乣truncated`銆乣range`銆乣recordPath`銆?

### 7.5 杩涜涓噸澶嶄换鍔″幓閲嶏紙P0-D锛?

`meetingstone_dispatch` 鍙**瀹屽叏鐩稿悓銆佷笖浠嶅湪杩涜涓?*锛坄queued` / `running`锛夌殑浠诲姟鍘婚噸锛?
鍛戒腑鏃惰繑鍥?*鏃㈡湁**浠诲姟鐨?`taskRef`锛堝師 `childId` / `jobId`锛変笌褰撳墠鐘舵€侊紝鍥炴墽鍦?搂7 鎴愬姛鍥炴墽
鍩虹涓婇檮 `deduplicated: true`銆乣status`銆佸彲閫?`deduplicatedFrom`锛?*涓?*鍒涘缓绗簩涓瓙浠诲姟銆佷笉鍗?
鏂伴搴︺€佷笉寤烘柊宸ヤ綔鏍戙€備緷鎹?`docs/reference/efficiency-v1.0.md` 搂3.5 / 搂5 琛?8 / 搂8銆?

#### 鎸囩汗缁勬垚锛堝繀椤荤‘璁ゃ€屽畬鍏ㄧ浉鍚屻€嶏紝缁濅笉浠?hash Prompt锛?

鍒ゅ畾鐢?`src/dispatch/dispatcher.js` 鐨?`fingerprintParts` / `computeFingerprint`锛氬瑙勮寖鍖栧璞″仛
绋冲畾搴忓垪鍖栵紙閿帓搴忥級鍚庡彇 sha256銆傚弬涓庡垽瀹氱殑淇℃伅锛?

| 缁勬垚 | 瀛楁 | 鍙樺寲鍚?|
| --- | --- | --- |
| 椤圭洰 / 宸ヤ綔鍖鸿韩浠?| realpath 褰掍竴鍖栧悗鐨?`projectKey` | 涓嶅悓椤圭洰涓嶅悎骞?|
| 瑙掕壊 ID 涓?provider / CLI | `roleId`銆乣channel.kind/provider/channelId/model/reasoning`銆乣prompt/description/timeoutMs` | 鎵ц鑳藉姏涓嶅悓涓嶅悎骞?|
| 瑙勮寖鍖栦换鍔″唴瀹?| `task.trim()`锛涙湁 TaskSpec 鏃剁敤缁撴瀯鍖栧瓧娈碉紙title/objective/scope/acceptance/evidence/contextRefs/outputBudget/permissionPreset锛夛紝鍚?ContextPack | 鐩爣鎴栬寖鍥翠笉鍚屼笉鍚堝苟 |
| 鐗堟湰鎸囩汗 | `git rev-parse HEAD`锛坵orktree 闅旂涓嬬瓑鍚?`baseSha`锛?| 浠ｇ爜鍙樺寲鍚庡厑璁搁噸鏂版墽琛?|
| 鐘舵€?| 鍥哄畾鐘舵€佹《 `in-progress`锛涚储寮曞彧瀛樿繘琛屼腑鏉＄洰 | 缁堟€佸嵆绉诲嚭绱㈠紩 |
| 鍏抽敭鍙傛暟 | `isolation`銆佹潈闄愭。浣嶃€佽緭鍑洪绠椼€乣continuesFrom` 閲嶆斁 | 鎵ц鏉′欢涓嶅悓涓嶅悎骞?|

鍛戒腑鏃剁殑鍥炴墽绀轰緥锛?

```json
{
  "ok": true,
  "taskRef": { "childId": "child-1", "jobId": "job-1", "provider": "acp" },
  "roleId": "role-sashi",
  "roleName": "娌欏儳",
  "isolation": "worktree",
  "deduplicated": true,
  "status": "running",
  "deduplicatedFrom": "child-1"
}
```

#### 璇垽杈圭晫锛堝畞鍙噸澶嶄篃涓嶈鍚堬級

- **鍙杩涜涓换鍔″幓閲?*锛氫换鍔＄粓鎬侊紙`onFinish` / `cancel` 纭鍋滄 / 鍚姩澶辫触锛夊嵆浠庡唴瀛樼储寮?
  绉婚櫎锛?*涓嶅鐢ㄥ凡瀹屾垚 / 澶辫触 / 鍙栨秷浠诲姟鐨勬棫缁撴灉**銆傚畬鎴愬悗鍐嶆娲剧浉鍚屼换鍔′細姝ｅ父鍒涘缓鏂颁换鍔°€?
- **鐗堟湰鎸囩汗鍙栦笉鍒版爣 `unknown` 涓斾笉鍙備笌鍒ゅ畾**锛氶潪 git 椤圭洰銆佹棤椤圭洰鏍广€乣git` 涓嶅湪 PATH 鎴栬秴鏃?
  鏃讹紝璇ヨ姹傛棦涓嶈繘绱㈠紩涔熶笉鍛戒腑绱㈠紩锛屼竴寰嬫甯稿垱寤猴紙涓嶅洜鏃犳硶纭鐗堟湰鑰岃鍚堬級銆?
- **淇℃伅涓嶈冻浠ヨ瘉鏄庡畬鍏ㄧ浉鍚?*锛氫换浣曞弬涓庡瓧娈电己澶辨垨鏃犳硶纭鏃舵寜銆屼笉鐩稿悓銆嶅鐞嗭紝鍒涘缓鏂颁换鍔°€?
- **绱㈠紩浠呭唴瀛?*锛歚Map`锛屾彃浠?/ DSH 閲嶅惎鍗冲け鏁堬紱涓嶅缓搴撱€佷笉钀界洏銆佷笉璺ㄨ繘绋嬪叡浜€?
- **骞跺彂瀹夊叏**锛氱浉鍚岃姹傚悓鏃跺埌杈炬椂**鍏堝崰浣嶅啀鍚姩**鈥斺€斿崰棰濆害涓庡啓鍘婚噸绱㈠紩鍦ㄥ悓涓€鍚屾鍧楀唴瀹屾垚锛?
  绗簩涓姹傚懡涓崰浣嶅悗绛夊緟棣栦釜浠诲姟鎷垮埌 `taskRef`锛堝彈鎺?pending promise锛夛紝鍙垱寤轰竴涓换鍔°€?
- **鏉冮檺 / 妯″瀷 / 闅旂妗ｄ綅宸紓閮藉弬涓庢寚绾?*锛氭湰椤圭洰涓嶆彁渚涢€愪换鍔℃潈闄愭。浣嶏紝浣?`isolation` 涓?
  `channel` 閰嶇疆涓嶅悓涓€寰嬩笉鍚堝苟锛涘幓閲嶄笉浼氭搮鑷彁鍗囨潈闄愩€佸垏鎹㈡ā鍨嬫垨鏀归殧绂绘柟寮忋€?
- **涓嶅仛**锛氫笉澶嶇敤杩囨湡缁撴灉銆佷笉寤轰换鍔￠槦鍒?/ 鏁版嵁搴?/ 鍏ㄩ噺浠诲姟鍘嗗彶銆佷笉瀵广€岀枒浼肩浉鍚屻€嶅仛妯＄硦
  鍚堝苟锛堜笉鍋氳涔夌浉浼煎害銆佷笉璋冪敤棰濆 AI 鍒ゅ畾锛夈€?

## 8. 瀹夸富鍘熺敓 Jobs锛堜换鍔″垪琛級

鏈彃浠朵笉鑷€犱换鍔″垪琛?UI銆傛淳鍗曟垚鍔熷悗锛屽鏋滃涓绘彁渚?`ctx.jobs`锛岄€傞厤鍣ㄤ細娉ㄥ唽涓€涓師鐢?Job锛?

- `kind`: `meetingstone-dispatch`
- `label`: `瑙掕壊绠€绉?路 绠€鐭洰鏍囷紙鈮?4 瀛楋級`锛屼緥濡?`鎮熺┖ 路 瀹℃牳鐧诲綍妯″潡`銆傜洰鏍囦紭鍏堝彇 `taskSpec.title`锛?
  鍏舵浠诲姟棣栦釜鏈夋晥琛岋紱鍓ョ Markdown 绗﹀彿涓?`meetingstone:` 鍐呴儴鍓嶇紑锛岀┖浠诲姟鍥為€€ `鏈懡鍚嶄换鍔銆?
  鍚屼竴涓悕瀛椾篃閫氳繃瀹樻柟 `startActivation({ label })` 鍐欒繘 Subagents 鐩綍锛堣 `docs/gui-0.2.0.md` 搂6锛夈€?
- `owner`: 鏈娲惧崟鐨?parent Agent 瀵瑰簲 SessionId锛堝涓荤敤 `agent.id === agent.session.id` 鏍￠獙锛?
- `jobId`: 鍚屾椂鍐欏叆 `taskRef` 涓?`.meetingstone/runs/<childId>.json`
- `progress`锛堣繍琛屼腑锛夛細鍙啓 `宸插惎鍔╜锛?*涓嶅啓宸ヤ綔鏍戠粷瀵硅矾寰?*
- `detail`锛堢粓鎬侊級锛歚hooks.done` 鐨?`detail`锛屾埅鍒?鈮?0 瀛楋紝浣滀负闈㈡澘绗簩琛岋紱瀹屾暣杈撳嚭浠嶅湪
  `.meetingstone/runs/<childId>.json` 涓?Job output ring 閲屻€傚伐浣滄爲/鍒嗘敮璺緞鍙暀鍦?run 璁板綍锛?
  涓嶅杩?Jobs 琛屻€?

琛屼负杈圭晫锛?

- **Jobs 涓嶅彲鐢ㄦ椂娲惧崟鐓у父**锛氭病鏈?`ctx.jobs`銆佹垨 `jobs.start` 鎶涢敊锛堜緥濡傚綋鍓?composition 娌″姞杞?
  `@deepseek-ai/dsh-tool-jobs`锛屾病鏈?controller 鏈嶅姟璇?owner锛夋椂锛屽彧璁颁竴鏉?warning锛屼笉寤?Job銆佷笉浼€?`jobId`銆?
- 浠诲姟缁堟€侊紙瀹屾垚/澶辫触/鍙栨秷/鎻掍欢鍗歌浇锛変細 resolve Job 鐨?`done`锛沗meetingstone_cancel_task` 浼樺厛璧?
  `ctx.jobs.kill()` 鈫?Job 鐨?`cancel`锛屽啀鍥炶惤鍒伴€傞厤鍣ㄥ師璺緞锛屼繚璇侀潰鏉夸笌宸ュ叿鍋滄鐨勬槸鍚屼竴涓换鍔°€?
- 鎻掍欢鏈韩**涓嶆嫢鏈?* Jobs 闈㈡澘锛涢潰鏉跨敱瀹夸富 `@deepseek-ai/dsh-tool-jobs` 鎻愪緵銆?

- **Jobs 不可用时派单照常**：没有 `ctx.jobs`、或 `jobs.start` 抛错（例如当前 composition 没加载
  `@deepseek-ai/dsh-tool-jobs`，没有 controller 服务该 owner）时，只记一条 warning，不建 Job、不伪造 `jobId`。
- 任务终态（完成/失败/取消/插件卸载）会 resolve Job 的 `done`；`meetingstone_cancel_task` 优先走
  `ctx.jobs.kill()` → Job 的 `cancel`，再回落到适配器原路径，保证面板与工具停止的是同一个任务。
- 插件本身**不拥有** Jobs 面板；面板由宿主 `@deepseek-ai/dsh-tool-jobs` 提供。
- **三个原生面板各管一摊**：Todo = 项目级工作包与里程碑，Background Tasks = 本插件派的宿主 Job，
  Subagents = Agent 执行会话；**派单不建 Todo**。职责边界、命名规则与宿主 API 证据见
  [`docs/gui-0.2.0.md`](gui-0.2.0.md) §6，本文件不重复。

## 9. 绀轰緥

- 鍏ㄥ眬浜旇鑹诧細[examples/meetingstone.desktop.yml](../examples/meetingstone.desktop.yml)
- 椤圭洰瑕嗙洊锛歔examples/project.meetingstone.json](../examples/project.meetingstone.json)
- 浠撳簱鑷瑙掕壊锛歔examples/selftest.roles.json](../examples/selftest.roles.json)锛坄role-selftest*`锛宨n-process / codex / acp 閫氶亾锛?
- 鏈粨搴撻」鐩厤缃細鏍圭洰褰?`.meetingstone.json`锛堜簲瑙掕壊 + 閫氶亾寮曠敤锛?

