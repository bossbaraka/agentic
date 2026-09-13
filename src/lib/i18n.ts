/**
 * الترجمة وكشف اللغة — العربية الافتراضية، English مدعوم بالكامل للواجهات.
 * النصوص التسويقية الطويلة تبقى من قاعدة المعرفة/النموذج؛ هذا القاموس للواجهات
 * (الأزرار، القوائم، رسائل الحجز الحتمية) فقط.
 */
export type UiLang = 'ar' | 'en';

type Dict = Record<string, string>;

const AR: Dict = {
  // لوحة المفاتيح الدائمة
  'menu.home': '🏠 الرئيسية',
  'menu.services': '🛎️ الخدمات',
  'menu.orders': '📋 طلباتي',
  'menu.bookings': '📅 حجوزاتي',
  'menu.support': '💬 الدعم',
  'menu.about': 'ℹ️ عن مُريح',
  // الرئيسية
  'home.title': '🏠 *الرئيسية — منصة مُريح*',
  'home.subtitle': 'منيو QR، شاشة مطبخ، كاشير، وخدمات رقمية — اكتب طلبك أو اختر من الأزرار.',
  'home.services': '🛎️ تصفّح الخدمات',
  'home.book': '📅 احجز موعدًا',
  'home.bookings': '📅 حجوزاتي',
  'home.orders': '📋 طلباتي',
  'home.support': '💬 تحدث مع الدعم',
  'home.about': 'ℹ️ عن مُريح',
  'home.lang': '🌐 English',
  // الخدمات
  'services.title': '🛎️ *خدمات مُريح*',
  'services.choose_category': 'اختر التصنيف:',
  'services.back': '🔙 رجوع',
  'services.price_from': 'السعر',
  'services.price_quote': 'حسب الطلب',
  'services.monthly': 'شهريًا',
  'services.yearly': 'سنويًا',
  'services.once': 'مرة واحدة',
  'services.duration': 'المدة المتوقعة',
  'services.features': 'المزايا',
  'services.book_slot': '📅 احجز موعد تفعيل',
  'services.request': '📝 اطلب الخدمة',
  'services.unavailable': 'هذه الخدمة غير متاحة حاليًا.',
  'services.page': 'الصفحة',
  'services.prev': '◀️ السابق',
  'services.next': 'التالي ▶️',
  // الحجز
  'booking.choose_date': 'اختر يوم الموعد:',
  'booking.choose_time': 'اختر الوقت المناسب يوم',
  'booking.confirm_title': '🔎 *راجع بيانات الحجز*',
  'booking.service': 'الخدمة',
  'booking.date': 'التاريخ',
  'booking.time': 'الوقت',
  'booking.name': 'الاسم',
  'booking.confirm_btn': '✅ تأكيد الحجز',
  'booking.cancel_btn': '↩️ إلغاء',
  'booking.confirmed_title': '✅ *تم تأكيد الحجز*',
  'booking.ref': 'رقم الحجز',
  'booking.reminder_note': 'سيتواصل معك الفريق في الموعد. يمكنك التعديل أو الإلغاء من «حجوزاتي».',
  'booking.failed_title': 'تعذّر الحجز',
  'booking.cancelled': 'تم إلغاء الحجز',
  'booking.cancel_confirm_q': 'هل أنت متأكد من إلغاء الحجز؟',
  'booking.yes_cancel': 'نعم، ألغِ',
  'booking.keep': 'لا، أبقهِ',
  'booking.reschedule': '✏️ إعادة الجدولة',
  'booking.cancel_b': '❌ إلغاء الحجز',
  'booking.none': 'لا توجد لديك حجوزات حاليًا. تقدر تحجز موعدًا من قسم الخدمات.',
  'booking.list_title': '📅 *حجوزاتي* — اختر حجزًا لعرض تفاصيله:',
  'booking.status': 'الحالة',
  'booking.reminder_24': 'تذكير ودّي: موعد تفعيلك غدًا في تمام الساعة',
  'booking.reminder_1': 'تذكير: موعد تفعيلك خلال ساعة تقريبًا في تمام الساعة',
  // طلب خدمة
  'order.confirm_q': '📝 سأجهّز طلبك على الخدمة التالية وأرسله للفريق:',
  'order.confirm_btn': '✅ أرسل الطلب',
  'order.created': 'تم استلام طلبك بنجاح ✅ رقم الطلب',
  'order.note': 'سيتواصل معك الفريق قريبًا لإكمال التفاصيل.',
  'order.none': 'لا توجد طلبات بعد.',
  'order.list_title': '📋 *طلباتي*:',
  'order.ref': 'رقم الطلب',
  'order.status': 'الحالة',
  'order.date': 'التاريخ',
  'order.service': 'الخدمة',
  // الدعم
  'support.title': '💬 *الدعم والمساعدة*',
  'support.body': 'فريقنا جاهز لمساعدتك. اضغط الزر لتحويل المحادثة لموظف بشري، أو اكتب سؤالك مباشرة وسأحاول مساعدتك فورًا.',
  'support.human': '🙋 تحدث مع موظف',
  'support.faq': '❓ الأسئلة الشائعة',
  'support.handoff_sent': 'حاضر، بوصلك بأحد الزملاء الحين 🙋 سيكمل معك بأقرب وقت. للعودة لي اضغط /menu.',
  // عن مُريح
  'about.title': 'ℹ️ *عن منصة مُريح*',
  // اللغة
  'lang.changed': 'تم التبديل إلى العربية ✅',
  // عام
  'common.back_home': '🏠 الرئيسية',
  'common.error': 'حدث خطأ مؤقت، حاول مرة أخرى بعد قليل. لو تكرر، اطلب موظفًا من قسم الدعم.',
  'common.not_owner': 'لا تملك صلاحية على هذا العنصر.',
  'common.no_results': 'لا توجد نتائج.',
};

const EN: Dict = {
  'menu.home': '🏠 Home',
  'menu.services': '🛎️ Services',
  'menu.orders': '📋 My Orders',
  'menu.bookings': '📅 My Bookings',
  'menu.support': '💬 Support',
  'menu.about': 'ℹ️ About',
  'home.title': '🏠 *Home — MUREEH*',
  'home.subtitle': 'QR menu, kitchen screen, POS, and digital services — type your request or pick below.',
  'home.services': '🛎️ Browse services',
  'home.book': '📅 Book an appointment',
  'home.bookings': '📅 My bookings',
  'home.orders': '📋 My orders',
  'home.support': '💬 Talk to support',
  'home.about': 'ℹ️ About MUREEH',
  'home.lang': '🌐 العربية',
  'services.title': '🛎️ *MUREEH Services*',
  'services.choose_category': 'Choose a category:',
  'services.back': '🔙 Back',
  'services.price_from': 'Price',
  'services.price_quote': 'On request',
  'services.monthly': '/month',
  'services.yearly': '/year',
  'services.once': 'one-time',
  'services.duration': 'Estimated duration',
  'services.features': 'What you get',
  'services.book_slot': '📅 Book an activation slot',
  'services.request': '📝 Request this service',
  'services.unavailable': 'This service is currently unavailable.',
  'services.page': 'Page',
  'services.prev': '◀️ Prev',
  'services.next': 'Next ▶️',
  'booking.choose_date': 'Choose an appointment day:',
  'booking.choose_time': 'Choose a time on',
  'booking.confirm_title': '🔎 *Review your booking*',
  'booking.service': 'Service',
  'booking.date': 'Date',
  'booking.time': 'Time',
  'booking.name': 'Name',
  'booking.confirm_btn': '✅ Confirm booking',
  'booking.cancel_btn': '↩️ Cancel',
  'booking.confirmed_title': '✅ *Booking confirmed*',
  'booking.ref': 'Booking ref',
  'booking.reminder_note': 'Our team will contact you at the appointment. You can reschedule or cancel from “My Bookings”.',
  'booking.failed_title': 'Booking failed',
  'booking.cancelled': 'Your booking has been cancelled',
  'booking.cancel_confirm_q': 'Are you sure you want to cancel this booking?',
  'booking.yes_cancel': 'Yes, cancel it',
  'booking.keep': 'No, keep it',
  'booking.reschedule': '✏️ Reschedule',
  'booking.cancel_b': '❌ Cancel booking',
  'booking.none': 'You have no bookings yet. Book an appointment from Services.',
  'booking.list_title': '📅 *My bookings* — tap one for details:',
  'booking.status': 'Status',
  'booking.reminder_24': 'Friendly reminder: your activation appointment is tomorrow at',
  'booking.reminder_1': 'Reminder: your activation appointment is in about an hour at',
  'order.confirm_q': '📝 I’ll prepare this request and send it to our team:',
  'order.confirm_btn': '✅ Send request',
  'order.created': 'Your request was received ✅ Order ref',
  'order.note': 'Our team will contact you shortly to finalize the details.',
  'order.none': 'You have no orders yet.',
  'order.list_title': '📋 *My orders*:',
  'order.ref': 'Order ref',
  'order.status': 'Status',
  'order.date': 'Date',
  'order.service': 'Service',
  'support.title': '💬 *Support*',
  'support.body': 'Our team is ready to help. Tap below to hand this chat to a human agent, or type your question and I’ll do my best right away.',
  'support.human': '🙋 Talk to a human',
  'support.faq': '❓ FAQ',
  'support.handoff_sent': 'Sure — connecting you with a teammate now 🙋 They’ll take over shortly. Press /menu to come back to me.',
  'about.title': 'ℹ️ *About MUREEH*',
  'lang.changed': 'Switched to English ✅',
  'common.back_home': '🏠 Home',
  'common.error': 'A temporary error occurred, please try again shortly. If it persists, contact support.',
  'common.not_owner': 'You don’t have permission for this item.',
  'common.no_results': 'No results.',
};

export function t(lang: string | null | undefined, key: string): string {
  const l: UiLang = lang === 'en' ? 'en' : 'ar';
  return (l === 'en' ? EN[key] : AR[key]) ?? AR[key] ?? key;
}

/**
 * كشف لغة النص — ar/en/he.
 * يعتمد نسبة المحارف (أمتن من الكلمات المفتاحية للنصوص القصيرة).
 */
export function detectLanguage(text: string): 'ar' | 'en' | 'he' | null {
  if (!text) return null;
  const arabic = (text.match(/[؀-ۿ]/g) ?? []).length;
  const hebrew = (text.match(/[֐-׿]/g) ?? []).length;
  const latin = (text.match(/[a-zA-Z]/g) ?? []).length;
  const total = arabic + hebrew + latin;
  if (total < 2) return null;
  if (arabic / total > 0.4) return 'ar';
  if (hebrew / total > 0.4) return 'he';
  if (latin / total > 0.6) return 'en';
  return null;
}

/** نص ثنائي اللغة يختار المناسب */
export function pickLang(lang: string | null | undefined, ar: string, en: string): string {
  return lang === 'en' ? (en || ar) : ar;
}

/** حالة الحجز للعرض */
export function bookingStatusText(status: string, lang: string | null | undefined): string {
  if (lang === 'en') {
    return { PENDING: 'Pending', CONFIRMED: 'Confirmed', COMPLETED: 'Completed', CANCELLED: 'Cancelled', NO_SHOW: 'No-show' }[status] ?? status;
  }
  return { PENDING: 'قيد التأكيد', CONFIRMED: 'مؤكّد', COMPLETED: 'مكتمل', CANCELLED: 'ملغى', NO_SHOW: 'بدون حضور' }[status] ?? status;
}

export function orderStatusText(status: string, lang: string | null | undefined): string {
  if (lang === 'en') {
    return { PENDING: 'Pending', CONFIRMED: 'Confirmed', IN_PROGRESS: 'In progress', COMPLETED: 'Completed', CANCELLED: 'Cancelled' }[status] ?? status;
  }
  return { PENDING: 'قيد المراجعة', CONFIRD: 'مؤكد', CONFIRMED: 'مؤكّد', IN_PROGRESS: 'قيد التنفيذ', COMPLETED: 'مكتمل', CANCELLED: 'ملغى' }[status] ?? status;
}
