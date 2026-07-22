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
