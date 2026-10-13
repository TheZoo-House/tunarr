import { DefaultChannel } from '@/helpers/constants.ts';
import { setCurrentChannel } from '@/store/channelEditor/actions.ts';
import { renderWithProviders, screen } from '@/test/utils.tsx';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import type { Channel, SaveableChannel } from '@tunarr/types';
import { FormProvider, useForm } from 'react-hook-form';
import { describe, expect, test, vi } from 'vitest';
import { ChannelPropertiesEditor } from './ChannelPropertiesEditor.tsx';

vi.mock('../../hooks/useChannels.ts', () => ({
  useChannels: () => ({ data: [] }),
}));

const channel: Channel = {
  ...DefaultChannel,
  id: 'channel',
  name: 'Channel 1',
  number: 1,
  startTime: 1_000_000,
  transcodeConfigId: 'config',
  autoSkipCredits: false,
};

function Form({
  initial,
  submit,
}: {
  initial: Channel;
  submit: (value: SaveableChannel) => void;
}) {
  const form = useForm<SaveableChannel>({ defaultValues: initial });
  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <FormProvider {...form}>
        <form onSubmit={form.handleSubmit(submit)}>
          <ChannelPropertiesEditor />
          <button type="submit">Save</button>
        </form>
      </FormProvider>
    </LocalizationProvider>
  );
}

describe('auto-skip credits channel control', () => {
  test.each([false, true])(
    'renders the persisted choice %p and submits its changed value',
    async (enabled) => {
      const initial = { ...channel, autoSkipCredits: enabled };
      setCurrentChannel(initial);
      const submit = vi.fn();
      const { user } = renderWithProviders(
        <Form initial={initial} submit={submit} />,
      );
      const toggle = screen.getByRole('checkbox', {
        name: 'Auto-skip credits',
      });
      if (enabled) expect(toggle).toBeChecked();
      else expect(toggle).not.toBeChecked();
      expect(
        screen.getByText(/Keep scenes between and after credits/),
      ).toBeVisible();
      await user.click(toggle);
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({ autoSkipCredits: !enabled }),
        expect.anything(),
      );
    },
  );
});
