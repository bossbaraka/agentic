/** خطأ أعمال مُصنّف — يترجمه المستدعي (أداة/قائمة) لرسالة مناسبة */
export class ServiceError extends Error {
  constructor(
    public code: 'validation' | 'forbidden' | 'not_found' | 'unavailable' | 'conflict' | 'internal',
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}
