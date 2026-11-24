/**
 * Traditional or simplified Chinese, line by line, without a conversion
 * library: each pair below is a common character whose traditional form is
 * not written in simplified text and whose simplified form is not written in
 * traditional text. Pairs whose simplified form is also a traditional
 * character of its own (后, 里, 干, 台, 云, 万, 系, 松, 面…) are left out:
 * they say nothing about the script.
 *
 * WHY: the uploads of the 27.8-hour series carry their song lyrics on screen
 * in traditional characters while the dialogue's subtitles (and the
 * transcript) are simplified, so a line in traditional characters in a
 * simplified transcript is most likely a lyric (claude-dubber report F7).
 * It is only ever a suggestion.
 */

/** Traditional then simplified, pair after pair. */
const PAIRS =
  '愛爱礙碍襖袄罷罢擺摆敗败頒颁辦办幫帮綁绑寶宝飽饱報报備备輩辈貝贝筆笔畢毕閉闭邊边編编變变標标別别賓宾餅饼撥拨補补財财參参' +
  '蠶蚕慘惨倉仓層层產产長长嘗尝場场腸肠廠厂暢畅車车徹彻塵尘陳陈稱称誠诚遲迟齒齿處处觸触傳传創创純纯詞词從从聰聪錯错達达' +
  '帶带單单擔担膽胆當当黨党導导島岛燈灯鄧邓敵敌遞递點点電电調调釘钉頂顶訂订東东動动凍冻獨独讀读斷断隊队對对噸吨奪夺兒儿爾尔' +
  '餓饿發发罰罚飯饭訪访紡纺飛飞費费紛纷墳坟奮奋憤愤風风鳳凤婦妇負负該该蓋盖趕赶剛刚鋼钢綱纲個个給给鞏巩貢贡構构購购夠够顧顾' +
  '關关觀观館馆廣广歸归貴贵櫃柜國国過过漢汉號号賀贺護护華华畫画話话懷怀壞坏歡欢環环還还換换黃黄揮挥輝辉匯汇會会貨货獲获擊击' +
  '機机積积級级計计記记紀纪濟济際际繼继價价駕驾間间堅坚艱艰監监減减簡简見见艦舰劍剑漸渐鍵键將将獎奖講讲醬酱膠胶驕骄腳脚較较' +
  '階阶節节潔洁結结緊紧進进盡尽勁劲經经驚惊靜静鏡镜競竞舊旧舉举劇剧決决覺觉絕绝軍军開开凱凯顆颗課课墾垦懇恳寬宽礦矿擴扩闊阔' +
  '蘭兰藍蓝爛烂勞劳樂乐淚泪類类離离禮礼歷历厲厉麗丽連连聯联憐怜臉脸戀恋練练糧粮兩两輛辆諒谅療疗遼辽獵猎臨临鄰邻靈灵齡龄領领' +
  '劉刘龍龙樓楼爐炉陸陆錄录綠绿亂乱輪轮論论羅罗蘿萝邏逻馬马媽妈嗎吗買买賣卖麥麦滿满貓猫們们夢梦彌弥綿绵緬缅廟庙滅灭鳴鸣銘铭' +
  '謀谋畝亩納纳難难腦脑鬧闹內内擬拟鳥鸟寧宁農农濃浓諾诺歐欧盤盘龐庞賠赔噴喷鵬鹏騙骗飄飘頻频貧贫評评憑凭撲扑舖铺齊齐騎骑豈岂' +
  '啟启氣气棄弃錢钱淺浅槍枪牆墙搶抢橋桥喬乔僑侨竅窍親亲輕轻傾倾慶庆窮穷區区驅驱軀躯權权勸劝確确讓让熱热認认榮荣軟软賽赛' +
  '傘伞喪丧掃扫殺杀紗纱曬晒傷伤賞赏燒烧紹绍設设攝摄審审嬸婶腎肾聲声勝胜繩绳聖圣師师詩诗獅狮濕湿實实識识時时勢势視视試试飾饰' +
  '釋释壽寿獸兽書书輸输屬属數数帥帅雙双誰谁稅税順顺說说碩硕絲丝飼饲訟讼頌颂蘇苏訴诉肅肃雖虽隨随歲岁孫孙損损鎖锁態态攤摊嘆叹' +
  '湯汤討讨騰腾題题條条鐵铁廳厅聽听頭头圖图團团襪袜灣湾網网為为圍围偉伟衛卫違违謂谓溫温聞闻穩稳問问窩窝烏乌無无務务霧雾' +
  '誤误戲戏細细蝦虾嚇吓鮮鲜閒闲顯显險险現现線线憲宪縣县鄉乡響响項项蕭萧銷销曉晓協协脅胁寫写謝谢興兴須须許许敘叙續续軒轩選选' +
  '學学尋寻詢询訓训遜逊壓压鴉鸦亞亚嚴严鹽盐顏颜驗验陽阳養养樣样搖摇遙遥藥药爺爷葉叶業业頁页醫医儀仪億亿憶忆義义藝艺議议' +
  '異异譯译陰阴銀银飲饮隱隐應应營营贏赢擁拥優优憂忧郵邮猶犹魚鱼漁渔與与語语獄狱預预園园圓圆員员遠远願愿約约躍跃閱阅運运韻韵' +
  '雜杂災灾載载讚赞暫暂髒脏責责則则賊贼贈赠閘闸齋斋債债戰战張张漲涨帳帐賬账趙赵這这貞贞針针陣阵鎮镇爭争睜睁證证鄭郑織织職职' +
  '執执紙纸質质鐘钟種种眾众晝昼豬猪諸诸燭烛囑嘱築筑鑄铸莊庄裝装壯壮狀状濁浊資资縱纵總总鄒邹組组鑽钻縷缕繞绕彈弹闖闯嬌娇壺壶' +
  '驀蓦楓枫瀟潇蘆芦遙遥謠谣緣缘鴛鸳鴦鸯悵怅鍾钟閣阁欄栏魯鲁漿浆嶺岭穌稣';

function buildSets(): { traditional: Set<string>; simplified: Set<string> } {
  const chars = [...PAIRS];
  const traditional = new Set<string>();
  const simplified = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i += 2) {
    traditional.add(chars[i]!);
    simplified.add(chars[i + 1]!);
  }
  // A character in both lists would count for both scripts: it counts for neither.
  for (const c of [...traditional]) {
    if (simplified.has(c)) {
      traditional.delete(c);
      simplified.delete(c);
    }
  }
  return { traditional, simplified };
}

const SETS = buildSets();

/** Characters only traditional text writes. */
export const TRADITIONAL_ONLY: ReadonlySet<string> = SETS.traditional;
/** Characters only simplified text writes. */
export const SIMPLIFIED_ONLY: ReadonlySet<string> = SETS.simplified;

const HAN = /\p{Script=Han}/u;

/** How many traditional-only and simplified-only characters a text holds, and its Han characters. Pure. */
export function scriptCounts(text: string): { traditional: number; simplified: number; han: number } {
  let traditional = 0;
  let simplified = 0;
  let han = 0;
  for (const c of text) {
    if (!HAN.test(c)) continue;
    han++;
    if (TRADITIONAL_ONLY.has(c)) traditional++;
    else if (SIMPLIFIED_ONLY.has(c)) simplified++;
  }
  return { traditional, simplified, han };
}
