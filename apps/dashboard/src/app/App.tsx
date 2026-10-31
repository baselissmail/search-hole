// SPDX-License-Identifier: Apache-2.0
import { CSPProvider } from '@base-ui/react/csp-provider'
import { Tooltip } from '@base-ui/react/tooltip'
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { Toaster } from 'sonner'
import { useTheme } from '../lib/theme.ts'
import { router } from './router.tsx'

function ThemedToaster() {
  const theme = useTheme()
  return (
    <Toaster
      theme={theme}
      position="bottom-right"
      closeButton
      visibleToasts={4}
      containerAriaLabel="Notifications"
      toastOptions={{ closeButtonAriaLabel: 'Dismiss notification' }}
    />
  )
}

export function App({ queryClient }: { queryClient: QueryClient }) {
  return (
    // Base UI renders no inline <style> elements: the CSP refuses them.
    <CSPProvider disableStyleElements>
      <QueryClientProvider client={queryClient}>
        <Tooltip.Provider delay={350}>
          <RouterProvider router={router} />
          <ThemedToaster />
        </Tooltip.Provider>
      </QueryClientProvider>
    </CSPProvider>
  )
}
