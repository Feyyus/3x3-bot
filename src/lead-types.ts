// Body of the Laravel -> worker relay call (POST /lead). Everything except `id`
// is optional: the site form allows any field to be empty.
export interface LeadPayload {
  id: number | string;
  createdAt?: string; // ISO 8601
  source?: string;
  name?: string;
  phone?: string;
  email?: string;
  company?: string;
  service?: string;
  message?: string;
  leadUrl?: string; // admin page of the lead
  briefUrl?: string; // uploaded brief file
}
