// Auto-generated from scripts/factory.py - do not edit by hand;
// regenerate with scripts/gen-bundle-templates.py
// Continuous factory supervisor: renders pending sheet stories back-to-back (unlimited per run), invents fresh stories when the queue is empty (retry x3 + builtin bank), syncs Drive hourly, chains the next run via the workflow
export const FACTORY_PY = `#!/usr/bin/env python3
"""StoryPilot - Video Factory supervisor (CONTINUOUS mode).

Runs inside a GitHub Actions job (factory.yml) and NEVER stops making
videos - the total count just keeps climbing (…11, 12, 13, 14, … 20 …
and beyond). One job renders back-to-back for ~5h, then CHAINS the next
run (the workflow's chain step re-dispatches it), so production is
continuous 24/7:

    1. sync the Google Sheet (Spark's live edits first)
    2. every story without a video -> AI HYPERFRAME FORGE
       (the keyless AI WRITES the renderer code, we run it,
        it repairs itself, built-in renderer as last resort)
    3. queue empty + INFINITE_STORIES=true -> the keyless AI invents a
       fresh story (retry x3, emergency builtin bank as fallback) so
       generation never stalls
    4. every finished video: state saved + pushed, Google Drive synced
       (DRIVE_SYNC_INTERVAL, default 1h = "sync with Drive every hour")
    5. time budget spent -> exit; the workflow chains the next run
       (reason=chain) so the loop never ends

Progress survives runs: state/videos.json (committed to the repo) records
every rendered story-hash, so nothing is ever re-processed and new/edited
Spark rows are picked up automatically. state/factory_status.json is the
live heartbeat file the StoryPilot app reads (phase, current story, queue
depth, recent runs) - refreshed continuously while the factory works.

Stop the factory: create state/FACTORY_STOP in the repo (the app exposes
this), or disable the "Continuous Video Factory" workflow.
"""
import json
import os
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)
os.chdir(ROOT)

import ai_forge          # noqa: E402
import drive_sync        # noqa: E402
import render_pending as rp  # noqa: E402

INFINITE_STORIES = os.environ.get("INFINITE_STORIES", "true").lower() in ("1", "true", "yes")
INVENT_ATTEMPTS = max(1, int(os.environ.get("INVENT_ATTEMPTS", "3")))
FACTORY_BUDGET_MIN = float(os.environ.get("FACTORY_BUDGET_MIN", "300"))
MARGIN_SEC = float(os.environ.get("FACTORY_MARGIN_SEC", "300"))
MIN_VIDEO_SLOT_SEC = float(os.environ.get("MIN_VIDEO_SLOT_SEC", "900"))
IDLE_POLL_SEC = int(os.environ.get("IDLE_POLL_SEC", "90"))
SHEET_TTL_SEC = float(os.environ.get("SHEET_TTL_SEC", "150"))
STATUS_PATH = os.environ.get("FACTORY_STATUS_PATH", "state/factory_status.json")
STOP_FILE = os.environ.get("FACTORY_STOP_FILE", "state/FACTORY_STOP")
STATUS_TICK_SEC = float(os.environ.get("STATUS_TICK_SEC", "30"))

# Topic rotation for AI-invented stories (Arabic - the channel's main language).
AI_STORY_TOPICS = [
    "قوة الفائدة المركبة وكيف تضاعف أموالك مع الوقت",
    "صندوق الطوارئ: درعك المالي الأول ضد المفاجآت",
    "الفرق بين الأصول والالتزامات ولماذا يفرق الأغنياء",
    "كيف تبدأ الاستثمار بمبلغ صغير جدا",
    "التضخم: اللص الصامت الذي يأكل مدخراتك",
    "الانضباط المالي: عادة صغيرة تغير حياتك",
    "صناديق المؤشرات للمبتدئين: الاستثمار بدون صداع",
    "الذهب أم الأسهم؟ أين تضع أموالك",
    "الدين الجيد والدين السيئ: متى الاقتراض ذكي؟",
    "التنويع الاستثماري: لا تضع كل البيض في سلة واحدة",
    "مخاطر محاولة توقيت السوق ولماذا يخسر معظم الناس",
    "الادخار التلقائي: ادفع لنفسك أولا",
    "قاعدة 72: احسب سرعة مضاعفة أموالك في ثانيتين",
    "العقلية طويلة الأجل: سر كبار المستثمرين",
    "الفقاعة المالية: كيف تعرفها قبل أن تنفجر",
    "الاستثمار في نفسك: أفضل عائد على الإطلاق",
    "كيف تقرأ القوائم المالية لشركة قبل شراء سهمها",
    "التقاعد المبكر: خطة FIRE بالأرقام الحقيقية",
    "أخطاء نفسية يقع فيها كل مستثمر مبتدئ",
    "الدخل السلبي: الحقيقة بدون مبالغة",
]


# Emergency story bank - the factory must NEVER come home empty-handed
# just because the keyless AI had a bad day. Each entry is a complete
# director-format story (same shape the AI invents). Hash-deduped like any
# other story: each bank story is rendered at most ONCE, ever.
def _bscene(i, tr, visual, prompt, vo, sfx):
    return {"index": i, "timeRange": tr, "visual": visual,
            "aiPrompt": prompt, "voiceover": vo, "sfx": sfx}


BUILTIN_STORIES = [
    {
        "title": "قاعدة الـ 72: احسب وقت مضاعفة أموالك بخطوة واحدة",
        "logline": "قاعدة حسابية بسيطة تكشف لك في ثوان كم سنة يحتاج استثمارك ليتضاعف، ولماذا الفرق الصغير في العائد يصنع سنوات كاملة.",
        "hook": "كم سنة تحتاج أموالك حتى تتضاعف؟",
        "lesson": "اقسم 72 على العائد السنوي لتعرف سنوات المضاعفة، وقارن الفرص قبل أن تستثمر.",
        "genre": "مالي",
        "duration": "75 Seconds",
        "language": "ar",
        "scenes": [
            _bscene(1, "0:00-0:07", "لقطة قريبة جدا لعينين تتأملان في غرفة معتمة، مع دفع كاميرا بطيء نحو الوجه، وشعاع ضوء بارد مائل يخترق العتمة تحوم فيه ذرات غبار ناعمة، وتدرج لوني أزرق فولاذي بارد يمنح المشهد حسا من الترقب الصامت.", "extreme close-up thoughtful eyes, cold blue rim light, floating dust, cinematic vertical", "كم سنة تحتاج أموالك حتى تتضاعف؟", "quiet room tone + deep sub drone + soft heartbeat thump"),
            _bscene(2, "0:07-0:15", "لقطة واسعة لمكتب خشبي عليه ورقة وقلم وآلة حاسبة قديمة، مع انسحاب كاميرا بطيء يكشف تفاصيل المكتب، وإضاءة مصباح دافئة تخترق عتمة الغرفة، وذرات غبار تتحرك داخل شعاع الضوء، وألوان باردة تتدرج بلطف نحو الدفء.", "wide shot vintage desk with calculator, warm lamp glow, dust motes, moody vertical", "قاعدة بسيطة تجيبك في أقل من عشر ثوان.", "vintage clock ticking + soft piano note + paper rustle"),
            _bscene(3, "0:15-0:22", "لقطة متوسطة لكف يكتب معادلة على لوح زجاجي شفاف، مع تتبع كاميرا بطيء من اليسار إلى اليمين، وأرقام متوهجة بالأزرق تطفو على الزجاج، وضباب خفيف يملأ الخلفية، وإضاءة نيون باردة تمنح الأرقام هالة سماوية.", "medium shot hand writing formula on glass, glowing blue numbers, neon rim, vertical", "اقسم اثنين وسبعين على عائد استثمارك السنوي.", "glass marker squeak + airy synth pad + number tick"),
            _bscene(4, "0:22-0:30", "لقطة قريبة لشاشة داكنة يصعد فيها منحنى نمو بثبات، مع دفع كاميرا تدريجي نحو قمة المنحنى، وجزيئات ضوء زرقاء تتطاير حول الأرقام الصاعدة، وخلفية باردة عميقة يلمع فيها الخط كطريق نجمي.", "close-up growth curve climbing dark screen, blue particles, futuristic glow, vertical", "عائد ثمانية بالمئة يضاعف مالك في تسع سنوات.", "data hum + rising electronic arpeggio + soft chime"),
            _bscene(5, "0:30-0:37", "لقطة علوية لطاولة عليها مساران متفرعان، خط أخضر يتقدم بوتيرة أسرع من خط أزرق، مع دوران كاميرا خفيف فوق الطاولة، وانعكاس إضاءة خضراء مزرقة على سطح لامع، وضباب رقيق يمنح العمق إحساس السباق.", "overhead shot two racing growth paths on table, teal green glow, misty depth, vertical", "وعائد اثنا عشر بالمئة يختصرها إلى ست سنوات.", "shimmering pad + fast ticking clock + whoosh accent"),
            _bscene(6, "0:37-0:45", "لقطة متوسطة لشخصين يقطعان ممرا طويلا بإيقاعين مختلفين والأسرع يسبق بمراحل، مع كاميرا محمولة تهتز قليلا وتتبع حركتهما، وأعمدة ضوء باردة تتناوب على الجدران، وبرودة زرقاء تكسو المشهد بأكمله.", "medium tracking shot two people walking corridor at different pace, cold pillars, handheld", "فرق بسيط في العائد يصنع سنوات كاملة من الانتظار.", "footsteps echo + tense low strings + clock tick"),
            _bscene(7, "0:45-0:52", "لقطة قريبة لميزان نحاسي قديم يتأرجح بين كومة ذهب وسؤال مشع، مع إمالة كاميرا هابطة نحو كفته، وإضاءة كهرمانية قوية من جانب واحد ترسم ظلالا حادة، وذرات غبار ذهبية تسبح في الضوء.", "close-up old balance scale gold vs glowing question, amber side light, dust, vertical", "لكن العائد المرتفع يجيء دائما مع مخاطر أكبر.", "metal creak + deep warning drone + coin drop"),
            _bscene(8, "0:52-1:00", "لقطة واسعة لشارع مدينة تعلوه لوحات أسعار تتغير أرقامها باستمرار، مع سحب كاميرا بطيء يبتعد عن الحشد المسرع، وضباب رمادي بارد يلف الشوارع، وألوان باهتة توحي بقوة خفية تعمل في صمت.", "wide shot busy city with changing price signs, gray fog, desaturated cold palette", "والتضخم الصامت يقتطع نصف قوتك الشرائية خلالها.", "city ambience + inflation riser + subtle alarm"),
            _bscene(9, "1:00-1:08", "لقطة متوسطة لكفين تضعان حجرين على طرفي ميزان زجاجي متوهج، مع دوران كاميرا كامل حول الميزان، وأضواء زرقاء تتحول تدريجيا إلى ذهبية دافئة، وانعكاسات ناعمة ترتجف على السطح الزجاجي.", "orbit shot hands placing stones on glowing glass balance, blue to gold light shift", "القاعدة الحقيقية أداة مقارنة لا وعد بالربح.", "glass chime + warm strings swell + soft impact"),
            _bscene(10, "1:08-1:15", "لقطة قريبة لعينين مبتسمتين تفيضان ثقة وسط هالة ضوء ذهبية دافئة، مع دفع كاميرا بطيء نحو الوجه، وخيوط ضوء ناعمة تسبح في الخلفية، وتدرج لوني دافئ يختم رحلة اللون من البرودة إلى الدفء.", "close-up confident smiling eyes, warm golden halo, soft bokeh lights, cinematic vertical", "فكم سنة تحتاج أموالك؟ شاركنا رقمك في التعليقات.", "warm outro pad + gentle piano + soft whoosh out"),
        ],
    },
    {
        "title": "فخ الخصومات: كيف تجعلك العروض تشتري ما لا تحتاج",
        "logline": "الخصم لا يوفر مالك بل يخلق إنفاقا جديدا، ودماغك تحسب ما وفزت به لا ما دفعته فعلا، والقاعدة الذهبية: ما ليس في قائمتك ليس صفقة.",
        "hook": "هل حققت وفرة حين اشتريت بنصف السعر؟",
        "lesson": "ما لم تكن مخططا لشرائه قبل رؤية العرض ليس صفقة مهما بلغ الخصم.",
        "genre": "مالي",
        "duration": "75 Seconds",
        "language": "ar",
        "scenes": [
            _bscene(1, "0:00-0:07", "لقطة قريبة جدا لعينين تتسعان أمام لافتة خصم حمراء ضخمة، مع دفع كاميرا بطيء نحو اللافتة، وأضواء نيون حمراء تومض في خلفية معتمة، وانعكاسات قرمزية ترتجف على وجه المشاهد، وتدرج لوني بارد يخفي وراءه مصيدة.", "extreme close-up wide eyes before giant red sale sign, crimson neon, dark", "هل حققت وفرة حين اشتريت بنصف السعر؟", "mall ambience + heartbeat bass + neon buzz"),
            _bscene(2, "0:07-0:15", "لقطة واسعة لمركز تجاري مزدحم تتدفق فيه الأكياس كقطيع، مع كاميرا محمولة تنساب بين المتسوقين، وأضواء سقف بيضاء باردة تسلط سطوعا مقصودا، وظلال متلاحقة تمنح الإيقاع إحساس الاندفاع الجماعي.", "wide handheld shot crowded mall shoppers with bags, cold white ceiling light", "الحقيقة أن الخصم لا يوفر مالا بل يخلق إنفاقا جديدا.", "crowd murmur + rhythmic footsteps + cart rattle"),
            _bscene(3, "0:15-0:22", "لقطة متوسطة لملصق سعر قديم مشطوب بخط أحمر بجانب سعر جديد لامع، مع إمالة كاميرا صاعدة من الملصق إلى رف البضائع، وإضاءة رفوف باردة تبرز التباين، وهالة حمراء تحيط بالسعر الجديد كوعد مغري.", "medium shot crossed-out price sticker next to new price, red halo", "المتجر يضع السعر الأصلي ليجعل الفرق يبدو مكسبا.", "sticker peel + curious pizzicato + subtle riser"),
            _bscene(4, "0:22-0:30", "لقطة قريبة لرأس يتأرجح بين نعم ولا فوق طاولة قرارات شفافة، مع دوران كاميرا خفيف حول الرأس، وأضواء متعاكسة زرقاء وحمراء تتزاحم على الوجه، وضباب رقيق يضاعف إحساس الحيرة الداخلية.", "close-up head hesitating between yes and no, blue red split light", "دماغك تحسب ما وفزت به لا ما دفعته فعلا.", "ticking clock + reversed voices whisper + low pulse"),
            _bscene(5, "0:30-0:37", "لقطة قريبة لمحفظة مفتوحة تخرج منها أوراق نقدية ببطء، مع سحب كاميرا هادئ يبتعد نحو كومة مشتريات متناثرة على الأرض، وإضاءة منزلية دافئة خافتة، وظلال ناعمة توحي بخسارة صامتة لا صوت لها.", "close-up open wallet bills leaving slowly, warm dim home light", "ثمانون دولارا بنصف السعر تبقى أربعين خرجت من جيبك.", "paper bills flip + melancholy piano + soft sigh"),
            _bscene(6, "0:37-0:45", "لقطة متوسطة لقائمة مشتريات مكتوبة بخط اليد تلوح بين الرفوف، مع تتبع كاميرا بطيء خلف القائمة الممسورة بكف ثابتة، وضوء نهاري بارد من نوافذ المتجر، وعمق ميدان ضحل يعزل القائمة عن فوضى الرغبات.", "medium handheld shot handwritten shopping list walking aisles, shallow depth", "السلعة التي لم تخطط لشرائها ليست صفقة أبدا.", "paper rustle + gentle strings + store hum"),
            _bscene(7, "0:45-0:52", "لقطة واسعة لساعة جدارية عملاقة تدور عقاربها بسرعة غير طبيعية فوق لافتة عروض ضخمة، مع إمالة كاميرا هابطة من الساعة إلى الحشد المتدافع، وإضاءة قرمزية متوترة، وومضات ضوء تمنح إحساس العد التنازلي.", "wide shot giant clock spinning fast above sale banner, crimson tension", "قوة الخصم الحقيقية تكمن في استعجالك قبل التفكير.", "fast clock ticking + tension riser + alarm blip"),
            _bscene(8, "0:52-1:00", "لقطة قريبة لدماغ متوهج بأسلوب الأشعة يضيء عند رؤية كلمة خصم، مع دفع كاميرا نحو البقعة الأكثر توهجا، وإضاءة مختبرية زرقاء باردة، وجزيئات ضوئية تتنفس ببطء وتكشف أثر المتعة الكيميائي.", "x-ray style glowing brain lighting up at discount word, lab blue", "المتاجر تعرف أن العرض يطلق هرمون المتعة في دماغك.", "neural hum + dopamine ping + deep sub drop"),
            _bscene(9, "1:00-1:08", "لقطة متوسطة لكف ترسم خطا أحمر حاسما على كلمة صفقة في قائمة، مع تتبع كاميرا بطيء خلف الكف، وإضاءة صباحية ذهبية تبدأ في كسر برودة المشهد، وذرات غبار دافئة تسبح في شعاع النافذة.", "medium shot hand crossing out word deal on list, morning gold", "قاعدة واحدة: ما ليس في قائمتك ليس صفقة.", "pen scratch + hopeful piano motif + warm pad"),
            _bscene(10, "1:08-1:15", "لقطة قريبة لوجه مبتسم هادئ يهز رأسه بثقة أمام مرآة منزلية، مع سحب كاميرا بطيء يكشف الغرفة الدافئة المحيطة، وأضواء مسائية ذهبية ناعمة، وتدرج لوني دافئ يختم رحلة اللون بانتصار الوعي.", "close-up confident calm face in mirror, warm evening glow", "ما آخر مرة اشتريت شيئا لم تكن تخطط له؟", "evening room tone + soft vinyl music + gentle exhale"),
        ],
    },
    {
        "title": "الرصيد النائم: ماذا تخسر أموالك المعطلة كل يوم؟",
        "logline": "الأموال الراقدة بلا عائد تخسر قيمتها بصمت كل يوم، والحل في التوازن بين وسادة طوارئ سائلة وباقٍ يعمل بعائد.",
        "hook": "أين تنام أموالك الليلة؟",
        "lesson": "اجعل نقودك تعمل: سيولة للمصائب وباقٍ يستثمر بعائد يحارب التضخم.",
        "genre": "مالي",
        "duration": "75 Seconds",
        "language": "ar",
        "scenes": [
            _bscene(1, "0:00-0:07", "لقطة قريبة جدا لعينين مغمضتين تفتحان ببطء في غرفة نوم معتمة، مع سحب كاميرا هادئ يبتعد نحو خزنة حديدية في الزاوية، وضوء قمر أزرق بارد يتسلل من النافذة، وظلال طويلة ساكنة توحي برقاد طويل.", "extreme close-up eyes opening in dark bedroom, cold moonlight", "أين تنام أموالك الليلة؟", "night crickets + soft breath + metal safe hum"),
            _bscene(2, "0:07-0:15", "لقطة علوية لأريكة تنام فوقها أوراق نقدية مغطاة بغطاء منمق، مع دوران كاميرا بطيء فوق المشهد، وإضاءة ليلية زرقاء، وضباب خفيف يمنح الأموال النائمة مظهر كائن حي في سبات عميق.", "overhead shot banknotes sleeping under blanket on couch, night blue", "النقود الراقدة في حساب لا عائد له تخسر يوميا.", "lullaby music box + blanket rustle + distant owl"),
            _bscene(3, "0:15-0:22", "لقطة متوسطة لكائن ضوئي صغير يقتطع قطعا من ورقة نقدية على طاولة، مع تتبع كاميرا لحركته المراوغة، وخلفية داكنة باردة، وومضات خفيفة عند كل قضمة تبتلع بها قيمة الورقة.", "medium shot light creature nibbling banknote, dark cold background", "التضخم يلتهم قيمتها بصمت وأنت تنتظر الفرصة المثالية.", "paper nibble + sneaky pizzicato + subtle alarm"),
            _bscene(4, "0:22-0:30", "لقطة قريبة لورقة نقدية تتبخر منها طبقات شفافة في تيار هواء بطيء، مع دفع كاميرا نحو الفتات المتطاير، وإضاءة خضراء مزرقة غريبة، وجزيئات تتبدد في الفراغ كأنها تذوب بلا أثر.", "close-up banknote layers evaporating in air stream, teal glow", "عشرة آلاف دولار تخسر مئات من قوتها الشرائية سنويا.", "air whoosh + fading shimmer + low mystery drone"),
            _bscene(5, "0:30-0:37", "لقطة واسعة لهاتف في اليد ينبض على شاشته حساب توفير متوهج كقلب نابض، مع إمالة كاميرا صاعدة من الشاشة إلى وجه صاحبه المبتسم، وضوء ذهبي دافئ يتسلل للمشهد، وانعكاسات ناعمة على الوجه.", "wide shot glowing savings app pulsing on phone, warm gold", "حساب التوفير ذو العائد يوقظ الرصيد النائم بلطف.", "app pulse chime + hopeful strings + warm pad"),
            _bscene(6, "0:37-0:45", "لقطة متوسطة لمنحنيين مرسومين على جدار زجاجي أحدهما ينطلق كالسهم والآخر شبه مستوٍ، مع حركة بانورامية أفقية من الضعيف إلى القوي، وأضواء زرقاء تتحول تدريجيا إلى ذهبية، وضباب يمنح العمق إحساس المسافة.", "medium shot two growth curves on glass wall, blue to gold", "الفارق بين عائد صفري وآخر معقول يتضاعف مع الوقت.", "graph hum + rising arpeggio + speed whoosh"),
            _bscene(7, "0:45-0:52", "لقطة قريبة لعجلة مائية خشبية قديمة تدور بماء ذهبي متلألئ تحت ضوء الشمس، مع دوران كاميرا كامل حول العجلة، وانعكاسات ذهبية راقصة على سطح الماء، وتنفس ضوئي دافئ يملأ الكادر بالحياة.", "close-up water wheel turning with golden water, sun sparkles", "السيولة الذكية مال يعمل حتى وهو في الانتظار.", "water wheel creak + flowing water + bright bells"),
            _bscene(8, "0:52-1:00", "لقطة واسعة لعاصفة رعدية تقترب من منزل صغير تلمع نوافذه بأمان داخلي، مع سحب كاميرا هادئ يكشف سياجا واقيا حول المنزل، وبرق بارد يضيء المشهد للحظات، ودفء داخلي يزداد وضوحا كلما اشتدت العاصفة.", "wide shot storm approaching safe glowing house, lightning flashes", "لكن الاحتياطي النقدي يبقى درعك الوحيد عند المفاجآت.", "thunder rumble + rain on glass + cozy interior"),
            _bscene(9, "1:00-1:08", "لقطة علوية لطاولة مقسمة إلى نصفين، نصف عملات ذهبية متلألئة ونصف خزنة صغيرة مغلقة، مع هبوط كاميرا عمودي بطيء نحو الطاولة، وإضاءة متوازنة بين الذهبي والأزرق، وظلال متساوية توحي بانسجام مقصود.", "overhead shot table split gold coins and small vault, balanced", "التوازن: وسادة طوارئ سائلة والباقي يستثمر بعائد.", "coins settle + balanced chime + gentle harmony"),
            _bscene(10, "1:08-1:15", "لقطة قريبة لعينين يقظتين تنظران إلى الأفق عند الفجر بثقة هادئة، مع دفع كاميرا بطيء نحو النافذة المضيئة، وضوء شروق ذهبي يغمر الكادر تدريجيا، ورحلة اللون تكتمل من البرودة إلى الدفء الكامل.", "close-up awake eyes at dawn horizon, golden sunrise flood", "فأين ينام رصيدك؟ في الخزنة أم في العمل؟", "morning birds + warm orchestral swell + soft breeze"),
        ],
    },
]


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(msg):
    print(f"[factory] {msg}", flush=True)


STATUS = {
    "phase": "boot",
    "mode": "continuous",
    "should_continue": True,
    "run": {},
    "current": None,
    "queue": {"pending": 0, "total": 0},
    "videos_this_run": 0,
    "videos_total": 0,
    "ai_invented_total": 0,
    "recent": [],
    "drive": None,
    "updated_at": now_iso(),
}


def refresh_drive_status():
    STATUS["drive"] = drive_sync.drive_status()


def write_status():
    STATUS["updated_at"] = now_iso()
    os.makedirs(os.path.dirname(STATUS_PATH) or ".", exist_ok=True)
    tmp = STATUS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(STATUS, f, ensure_ascii=False, indent=2)
    os.replace(tmp, STATUS_PATH)


def _start_status_ticker():
    """Keep factory_status.json fresh DURING long renders too (the app reads
    it live): every STATUS_TICK_SEC the timestamp + elapsed seconds refresh,
    so 'the factory is working' is always visibly true, never silent."""
    def tick():
        while True:
            time.sleep(STATUS_TICK_SEC)
            cur = STATUS.get("current")
            if cur and cur.get("started_at"):
                try:
                    t0 = time.mktime(time.strptime(cur["started_at"], "%Y-%m-%dT%H:%M:%SZ"))
                    cur["elapsed_sec"] = int(time.time() - time.mktime(time.gmtime(t0)))
                except Exception:
                    pass
            try:
                write_status()
            except Exception:
                pass
    th = threading.Thread(target=tick, daemon=True)
    th.start()
    return th


def stopped():
    return os.path.exists(STOP_FILE)


def push_state():
    """Best-effort git commit+push of the state files (GitHub runs only)."""
    if not os.environ.get("GH_TOKEN"):
        return
    try:
        subprocess.run(["git", "config", "user.name", "storypilot-bot"], check=False)
        subprocess.run(["git", "config", "user.email",
                        "41898282+github-actions[bot]@users.noreply.github.com"], check=False)
        subprocess.run(["git", "add", "state/"], check=False)
        r = subprocess.run(["git", "diff", "--cached", "--quiet"], capture_output=True)
        if r.returncode == 0:
            return  # nothing new
        subprocess.run(["git", "commit", "-m", "factory: state update [skip ci]"],
                       check=False, capture_output=True)
        for _ in range(2):
            p = subprocess.run(["bash", "-c", "git pull --rebase origin main && git push"],
                               capture_output=True, text=True)
            if p.returncode == 0:
                log("state pushed to the repo")
                return
            time.sleep(4)
        log("::warning::could not push state - next run may redo one video (harmless)")
    except Exception as e:
        log(f"::warning::push_state failed: {e}")


def _sheet_stories(cache):
    """Collect all sheet stories with a TTL cache (Spark edits mid-run are picked up)."""
    now = time.time()
    if cache["data"] is None or now - cache["at"] > SHEET_TTL_SEC:
        try:
            stories = rp.collect_stories()
            for st in stories:
                st["_hash"] = rp.story_hash(st)
            cache["data"], cache["at"] = stories, now
            STATUS["queue"]["total"] = len(stories)
        except Exception as e:
            log(f"sheet sync failed: {e}")
            if cache["data"] is None:
                cache["data"] = []
    return cache["data"]


def _normalize_story(data, route):
    """Fill defaults so any source (AI / bank) yields a complete story."""
    if not data.get("scenes") or not data.get("title"):
        raise ValueError("story missing title/scenes")
    data["scenes"] = data["scenes"][:12]
    for i, s in enumerate(data["scenes"], 1):
        s.setdefault("index", i)
        s.setdefault("timeRange", f"scene {i}")
        s.setdefault("visual", "")
        s.setdefault("aiPrompt", "")
        s.setdefault("voiceover", "")
        s.setdefault("sfx", "")
    data.setdefault("language", "ar")
    data.setdefault("duration", "60 Seconds")
    data["narration"] = data.get("narration") or " ".join(s["voiceover"] for s in data["scenes"])
    data["logline"] = data.get("logline") or data["title"]
    data["genre"] = data.get("genre") or "مالي"
    data["_route"] = route
    return data


def _builtin_story(state):
    """First bank story never rendered yet (hash-deduped like AI stories)."""
    for story in BUILTIN_STORIES:
        candidate = _normalize_story(json.loads(json.dumps(story)), "builtin-bank")
        candidate["_hash"] = rp.story_hash(candidate)
        if candidate["_hash"] not in state.get("rendered", {}):
            return candidate
    return None


def invent_story(state):
    """Ask the keyless AI for a brand-new story (rotating topics, no repeats).

    Retries malformed/failed asks INVENT_ATTEMPTS times, then falls back to
    the emergency builtin story bank so the factory still produces.
    """
    n = int(state.get("ai_invented_count", 0))
    recent = [t.get("title", "") for t in state.get("ai_titles", [])[-40:]]
    system = (
        'You are the showrunner of an Arabic cinematic vertical-video channel. Reply with ONLY '
        'a JSON object: {"title": str, "logline": str, "hook": str, "lesson": str, "genre": str, '
        '"duration": "75 Seconds", "language": "ar", "scenes": [{"index": 1, '
        '"timeRange": "0:00-0:07", "visual": str, "aiPrompt": str, "voiceover": str, "sfx": str}]}. '
        'EXACTLY 10 scenes with contiguous timeRanges totalling 60-90 seconds. Each "voiceover" is '
        'ONE sentence of Modern Standard Arabic (max 12 words, no diacritics); scene 1 is a hook '
        'question, scenes 8-9 carry the twist, scene 10 ends with a question to the audience. Each '
        '"visual" is one directing sentence (25+ words): shot size + subject DOING something + an '
        'explicit CAMERA MOVE (push-in/pull-out/pan/tilt/handheld/orbit - different every scene, '
        'never static) + moving atmosphere (dust/rain/fog/embers/light rays) + light & palette; '
        'cold tones early, warm at the end. "aiPrompt" is a short ENGLISH cinematic image prompt '
        '(different shot size every scene). "sfx" is 3 English layers: ambience + music + hit. '
        'Never repeat a previous title.'
    )
    last_err = None
    for attempt in range(1, INVENT_ATTEMPTS + 1):
        topic = AI_STORY_TOPICS[(n + attempt - 1) % len(AI_STORY_TOPICS)]
        prompt = f"Write a fresh 75-second director's storyboard story about: {topic}"
        if recent:
            prompt += "\\n\\nThese were used recently (do NOT repeat them): " + "; ".join(recent[:12])
        try:
            text, route = ai_forge.keyless_chat(prompt, system)
            data = _normalize_story(ai_forge.extract_json(text), route)
            log(f"invented '{data['title']}' via {route} (attempt {attempt})")
            return data
        except Exception as e:
            last_err = e
            log(f"invention attempt {attempt}/{INVENT_ATTEMPTS} failed: {str(e)[:160]}")
            if attempt < INVENT_ATTEMPTS:
                time.sleep(4)
    story = _builtin_story(state)
    if story:
        log(f"keyless invention failed {INVENT_ATTEMPTS}x - builtin story bank provides "
            f"'{story['title']}'")
        return story
    raise RuntimeError(f"invention failed and builtin bank exhausted: {last_err}")


def merge_invention_bookkeeping(state, full_state_path):
    """load_union_state returns ONLY {rendered, failed}; pull the invention
    bookkeeping (topic rotation + no-repeat titles) back from videos.json, or
    saving would silently reset it to 0/[] (seen in production Oct 8)."""
    try:
        with open(full_state_path, encoding="utf-8") as f:
            full = json.load(f)
        state["ai_invented_count"] = max(int(state.get("ai_invented_count", 0)),
                                         int(full.get("ai_invented_count", 0)))
        seen = {t.get("title") for t in state.get("ai_titles", [])}
        merged = list(state.get("ai_titles", []))
        for t in full.get("ai_titles", []):
            if t.get("title") not in seen:
                merged.append(t)
                seen.add(t["title"])
        state["ai_titles"] = merged[-60:]
    except Exception:
        pass
    return state


def forge_one(story, out_dir, deadline, source_label):
    """Forge one video and update the persistent state around it."""
    h = story["_hash"]
    STATUS["current"] = {
        "title": story.get("title", ""),
        "source": source_label,
        "started_at": now_iso(),
    }
    write_status()
    t0 = time.time()
    res = ai_forge.forge_story(story, out_dir, deadline=deadline, fps=str(rp.FRAME_RATE))
    dt = time.time() - t0
    ok = res.get("mode") in ("ai", "builtin")
    entry = {
        "title": story.get("title", ""),
        "tab": story.get("tabName", source_label),
        "renderedAt": now_iso(),
        "fps": int(rp.FRAME_RATE),
        "dir": os.path.basename(out_dir),
        "source": source_label,
        "renderer": res.get("mode"),
        "code_by": res.get("model", ""),
        "ai_attempts": res.get("attempts", 0),
    }
    return ok, entry, dt, res


def main():
    t0 = time.time()
    deadline = t0 + FACTORY_BUDGET_MIN * 60
    STATUS["run"] = {
        "started_at": now_iso(),
        "deadline_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(deadline)),
        "budget_min": FACTORY_BUDGET_MIN,
        "mode": "continuous",
        "infinite_stories": INFINITE_STORIES,
    }
    write_status()
    _start_status_ticker()
    log(f"factory boot [CONTINUOUS]: budget {FACTORY_BUDGET_MIN:.0f}m | "
        f"infinite-stories={INFINITE_STORIES} | hyperframes {rp.FRAME_RATE}fps | "
        f"drive sync every {drive_sync.SYNC_INTERVAL:.0f}s")

    # union of state/videos.json + every state/videos.shard*.json written by the
    # parallel hourly-video workers - without this the factory would re-render
    # every story that lives in a shard file
    state = (rp.load_union_state() if hasattr(rp, "load_union_state")
             else rp.load_state())
    merge_invention_bookkeeping(state, rp.STATE_PATH)
    state.setdefault("ai_invented_count", 0)
    state.setdefault("ai_titles", [])
    STATUS["videos_total"] = len(state.get("rendered", {}))
    cache = {"data": None, "at": 0.0}
    made = 0
    seq = 0
    attempted: set = set()  # story hashes already tried this run (no instant re-loops)
    stop_reason = "budget"

    # first pass right away if the hourly TTL already elapsed (chained runs),
    # then after every finished video - maybe_sync() self-throttles to
    # DRIVE_SYNC_INTERVAL (default 1h), so this is "sync with Drive every hour"
    drive_sync.maybe_sync()
    refresh_drive_status()

    while True:
        if stopped():
            stop_reason = "stopped"
            STATUS["should_continue"] = False
            log("STOP file found - shutting the factory down gracefully")
            break
        remaining = deadline - time.time()
        if remaining < MARGIN_SEC:
            stop_reason = "deadline"
            log(f"time budget nearly spent ({(time.time() - t0) / 60:.0f}m used) - "
                f"chaining the next run")
            break
        if remaining < MIN_VIDEO_SLOT_SEC:
            log(f"only {remaining / 60:.0f}m left - not enough for another video safely")
            stop_reason = "deadline"
            break

        stories = _sheet_stories(cache)
        pending = [st for st in stories if rp.is_pending(st, state) and st["_hash"] not in attempted]
        STATUS["queue"]["pending"] = len(pending)
        want_invent = INFINITE_STORIES
        STATUS["phase"] = ("rendering" if pending
                           else ("inventing" if want_invent else "idle"))
        write_status()

        if pending:
            story = pending[0]
            attempted.add(story["_hash"])
            seq += 1
            slug = f"{seq:02d}-{story['_hash'][:8]}"
            out_dir = os.path.join(rp.VIDEOS_DIR, slug)
            log(f"pending {len(pending)} | forging '{story['title']}' [{story['tabName']}]")
            try:
                ok, entry, dt, res = forge_one(story, out_dir, deadline, "sheet")
                state["rendered"][story["_hash"]] = entry
                state["failed"].pop(story["_hash"], None)
                made += 1
                STATUS["videos_this_run"] = made
                STATUS["videos_total"] = len(state["rendered"])
                STATUS["recent"] = (STATUS["recent"] + [{
                    "title": story["title"], "source": "sheet", "ok": ok,
                    "renderer": res.get("mode"), "code_by": res.get("model"),
                    "seconds": round(dt), "at": now_iso(),
                }])[-10:]
                log(f"DONE '{story['title']}' in {dt / 60:.1f}m via {res.get('mode')} "
                    f"(code by {res.get('model')}) - total {len(state['rendered'])}")
            except Exception as e:
                msg = str(e)[:300]
                log(f"FAILED '{story['title']}': {msg}")
                prev = state["failed"].get(story["_hash"], {})
                state["failed"][story["_hash"]] = {
                    "title": story["title"], "error": msg, "at": now_iso(),
                    "tries": int(prev.get("tries", 0)) + 1,
                }
                STATUS["recent"] = (STATUS["recent"] + [{
                    "title": story["title"], "source": "sheet", "ok": False,
                    "error": msg[:160], "at": now_iso(),
                }])[-10:]
            STATUS["current"] = None
            rp.save_state(state)
            push_state()
            drive_sync.maybe_sync()
            refresh_drive_status()
            write_status()
            continue

        if want_invent:
            try:
                story = invent_story(state)
            except Exception as e:
                log(f"story invention failed: {str(e)[:200]} - retrying after a pause")
                STATUS["phase"] = "inventing"
                write_status()
                time.sleep(60)
                continue
            story["_hash"] = rp.story_hash(story)
            if story["_hash"] in state["rendered"]:
                log("invented story was already rendered - inventing another")
                continue
            seq += 1
            slug = f"ai{seq:02d}-{story['_hash'][:8]}"
            out_dir = os.path.join(rp.VIDEOS_DIR, slug)
            source = "builtin-bank" if story.get("_route") == "builtin-bank" else "ai-invented"
            log(f"sheet queue empty - forging {source} story '{story['title']}'")
            try:
                ok, entry, dt, res = forge_one(story, out_dir, deadline, source)
                entry["topic"] = AI_STORY_TOPICS[int(state.get("ai_invented_count", 0)) % len(AI_STORY_TOPICS)]
                state["rendered"][story["_hash"]] = entry
                state["ai_invented_count"] = int(state.get("ai_invented_count", 0)) + 1
                state["ai_titles"] = (state.get("ai_titles", []) + [{"title": story["title"]}])[-60:]
                made += 1
                STATUS["videos_this_run"] = made
                STATUS["videos_total"] = len(state["rendered"])
                STATUS["ai_invented_total"] = state["ai_invented_count"]
                STATUS["recent"] = (STATUS["recent"] + [{
                    "title": story["title"], "source": source, "ok": ok,
                    "renderer": res.get("mode"), "code_by": res.get("model"),
                    "seconds": round(dt), "at": now_iso(),
                }])[-10:]
                log(f"DONE ({source}) '{story['title']}' in {dt / 60:.1f}m - "
                    f"total {len(state['rendered'])}")
            except Exception as e:
                msg = str(e)[:300]
                log(f"FAILED (AI-invented) '{story['title']}': {msg}")
                STATUS["recent"] = (STATUS["recent"] + [{
                    "title": story.get("title", "?"), "source": source, "ok": False,
                    "error": msg[:160], "at": now_iso(),
                }])[-10:]
            STATUS["current"] = None
            rp.save_state(state)
            push_state()
            drive_sync.maybe_sync()
            refresh_drive_status()
            write_status()
            continue

        # INFINITE_STORIES=false and queue empty: wait for Spark to add stories
        STATUS["phase"] = "idle"
        write_status()
        log(f"queue empty - re-checking the sheet in {IDLE_POLL_SEC}s")
        time.sleep(IDLE_POLL_SEC)
        cache["at"] = 0.0  # force a fresh sync next pass

    STATUS["phase"] = ("stopped" if stop_reason == "stopped" else "chaining_next_run")
    STATUS["current"] = None
    STATUS["queue"]["pending"] = len([
        st for st in (cache["data"] or []) if rp.is_pending(st, state)])
    STATUS["run"]["finished_at"] = now_iso()
    STATUS["run"]["videos_made"] = made
    STATUS["run"]["stop_reason"] = stop_reason
    STATUS["videos_total"] = len(state.get("rendered", {}))
    # graceful shutdown: flush anything the hourly tick hasn't synced yet
    # (dedup still applies - only videos missing from Drive are uploaded)
    if stop_reason != "stopped":
        try:
            drive_sync.maybe_sync(respect_ttl=False)
        except Exception as e:
            log(f"::warning::final drive sync failed: {str(e)[:200]}")
    refresh_drive_status()
    write_status()
    rp.save_state(state)
    push_state()
    log(f"factory run complete: {made} videos this run | {STATUS['videos_total']} total | "
        f"{STATUS['queue']['pending']} still pending | reason={stop_reason}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        STATUS["phase"] = "interrupted"
        write_status()
        log("interrupted")
`
