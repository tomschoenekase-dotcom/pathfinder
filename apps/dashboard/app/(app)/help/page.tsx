import { redirect } from 'next/navigation'

/** The simple portal consolidates help into Torchico Support. */
export default function HelpPage() {
  redirect('/support')
}
