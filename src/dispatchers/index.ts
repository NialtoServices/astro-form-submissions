export type { DispatchContext, Dispatcher } from '#dispatchers/dispatcher.js'

export {
  EmailDispatcher,
  renderEmail,
  type AddressInput,
  type OptionalAddressInput,
  type EmailContent,
  type EmailMessage,
  type EmailDispatcherOptions,
  type EmailTemplates,
  type EmailTransport
} from '#dispatchers/email.js'

export {
  resolveField,
  resolveFields,
  type FieldInput,
  type FieldSpec,
  type ResolvedField
} from '#dispatchers/fields.js'

export type { EmailTemplateCopy } from '#dispatchers/email-view.js'

export {
  submissionNotificationTemplates,
  type SubmissionNotificationTemplatesOptions
} from '#dispatchers/submission-notification.js'

export {
  submissionAcknowledgementTemplates,
  type AcknowledgementContact,
  type SubmissionAcknowledgementTemplatesOptions
} from '#dispatchers/submission-acknowledgement.js'

export { mustacheTemplates, type MustacheTemplatesOptions } from '#dispatchers/mustache.js'

export { PostmarkTransport, type PostmarkTransportOptions } from '#dispatchers/postmark.js'

export {
  DiscordDeliveryError,
  DiscordDispatcher,
  type DiscordField,
  type DiscordFieldInput,
  type DiscordFieldSpec,
  type DiscordDispatcherOptions
} from '#dispatchers/discord.js'
