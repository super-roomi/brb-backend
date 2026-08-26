import { type Lang } from "./localize.js";

// Localized copy for every push / in-app notification. Content names (barber,
// service, shop) are localized by the caller (via `localize`) before being
// passed in, so these builders only handle the surrounding template text.

export interface NotificationText {
  title: string;
  body: string;
}

export function bookingConfirmed(
  lang: Lang,
  p: { barber: string; service: string; shop: string },
): NotificationText {
  switch (lang) {
    case "ar":
      return {
        title: "تم تأكيد الحجز",
        body: `أكّد ${p.barber} حجزك لـ${p.service} في ${p.shop}.`,
      };
    case "ckb":
      return {
        title: "حجز پشتڕاستکرایەوە",
        body: `${p.barber} حجزەکەت بۆ ${p.service} لە ${p.shop} پشتڕاستکردەوە.`,
      };
    default:
      return {
        title: "Booking confirmed",
        body: `${p.barber} confirmed your ${p.service} at ${p.shop}.`,
      };
  }
}

export function bookingDeclined(
  lang: Lang,
  p: { barber: string; service: string; shop: string },
): NotificationText {
  switch (lang) {
    case "ar":
      return {
        title: "تم رفض الحجز",
        body: `لم يتمكن ${p.barber} من قبول حجزك لـ${p.service} في ${p.shop}. الرجاء اختيار وقت آخر.`,
      };
    case "ckb":
      return {
        title: "حجز ڕەتکرایەوە",
        body: `${p.barber} نەیتوانی حجزەکەت بۆ ${p.service} لە ${p.shop} وەربگرێت. تکایە کاتێکی تر هەڵبژێرە.`,
      };
    default:
      return {
        title: "Booking declined",
        body: `${p.barber} could not take your ${p.service} at ${p.shop}. Please pick another time.`,
      };
  }
}

export function newReservation(
  lang: Lang,
  p: { customer: string; service: string; pending: boolean },
): NotificationText {
  if (p.pending) {
    switch (lang) {
      case "ar":
        return { title: "طلب حجز جديد", body: `طلب ${p.customer} حجز ${p.service}. اضغط للمراجعة.` };
      case "ckb":
        return { title: "داواکاری حجزی نوێ", body: `${p.customer} داوای ${p.service}ی کرد. بۆ پێداچوونەوە دەستبنێ.` };
      default:
        return { title: "New booking request", body: `${p.customer} requested ${p.service}. Tap to review.` };
    }
  }
  switch (lang) {
    case "ar":
      return { title: "حجز جديد", body: `حجز ${p.customer} ${p.service}.` };
    case "ckb":
      return { title: "حجزی نوێ", body: `${p.customer} ${p.service}ی حجزکرد.` };
    default:
      return { title: "New booking", body: `${p.customer} booked ${p.service}.` };
  }
}

export function bookingReminder(
  lang: Lang,
  p: { service: string; shop: string; minutes: number },
): NotificationText {
  switch (lang) {
    case "ar":
      return {
        title: "موعد قادم",
        body: `موعدك لـ${p.service} في ${p.shop} بعد حوالي ${p.minutes} دقيقة.`,
      };
    case "ckb":
      return {
        title: "چاوەڕوانی کات",
        body: `کاتی ${p.service}ەکەت لە ${p.shop} نزیکەی ${p.minutes} خولەکی ماوە.`,
      };
    default:
      return {
        title: "Upcoming appointment",
        body: `Your ${p.service} at ${p.shop} is in about ${p.minutes} minutes.`,
      };
  }
}

export function referralFriendJoined(
  lang: Lang,
  p: { friend: string | null },
): NotificationText {
  // Apple hides the real name behind a relay for some accounts, and a customer
  // may simply have no name set — fall back to "your friend" rather than a gap.
  const who =
    p.friend ??
    (lang === "ar" ? "صديقك" : lang === "ckb" ? "هاوڕێکەت" : "your friend");
  switch (lang) {
    case "ar":
      return {
        title: "انضم صديقك",
        body: `حجز ${who} في نفس الصالون. امسحا رمز الحلّاق معًا للحصول على الخصم.`,
      };
    case "ckb":
      return {
        title: "هاوڕێکەت بەشدار بوو",
        body: `${who} لە هەمان شوێن حجزی کرد. پێکەوە کۆدی سەرتاشەکە سکان بکەن بۆ داشکاندنەکە.`,
      };
    default:
      return {
        title: "Your friend joined",
        body: `${who} booked at the same barbershop. Scan the barber's code together to get your discount.`,
      };
  }
}

export function referralDiscountEarned(
  lang: Lang,
  p: { amount: number; lang: Lang },
): NotificationText {
  // Digits are localized here (not by the caller) because this is the only
  // place the amount appears, and Arabic/Kurdish render Eastern Arabic digits.
  const amount = localizeAmount(p.amount, p.lang);
  switch (lang) {
    case "ar":
      return {
        title: "تم تطبيق الخصم",
        body: `حصلت أنت وصديقك على خصم ${amount} د.ع لكل منكما.`,
      };
    case "ckb":
      return {
        title: "داشکاندن جێبەجێ کرا",
        body: `تۆ و هاوڕێکەت هەریەکە ${amount} د.ع داشکاندنتان وەرگرت.`,
      };
    default:
      return {
        title: "Discount applied",
        body: `You and your friend each got ${amount} IQD off.`,
      };
  }
}

const EASTERN_DIGITS = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];

// Group thousands, then map to Eastern Arabic-Indic digits for ar/ckb. Mirrors
// the app's own `money` helper so a push reads the same as the screen it links to.
function localizeAmount(amount: number, lang: Lang): string {
  const grouped = amount.toLocaleString("en-US");
  if (lang !== "ar" && lang !== "ckb") return grouped;
  return grouped.replace(/[0-9]/g, (d) => EASTERN_DIGITS[Number(d)]);
}

export function referralDealStarted(
  lang: Lang,
  p: { shop: string; amount: number; lang: Lang },
): NotificationText {
  const amount = localizeAmount(p.amount, p.lang);
  switch (lang) {
    case "ar":
      return {
        title: "عرض جديد: أحضر صديقًا",
        body: `${p.shop} يقدّم الآن خصم ${amount} د.ع لكل شخص عند الحجز مع صديق.`,
      };
    case "ckb":
      return {
        title: "داشکاندنی نوێ: هاوڕێیەک بهێنە",
        body: `${p.shop} ئێستا ${amount} د.ع داشکاندن پێشکەش دەکات بۆ هەر کەسێک کاتێک لەگەڵ هاوڕێیەک حیجز دەکەیت.`,
      };
    default:
      return {
        title: "New bring-a-friend deal",
        body: `${p.shop} is now offering ${amount} IQD off each when you book with a friend.`,
      };
  }
}
