import { memo } from 'react';
import { TooltipProvider } from '@cube-dev/ui-kit';
import { PrimaryKeyFontAwesomeIcon } from '../../shared/icons/FontAwesomeIcons';

export const PrimaryKeyIcon = memo(({ color }: { color?: string }) => (
  <TooltipProvider activeWrap title="Este membro é a chave primária deste cubo/visão" delay={1000}>
    <PrimaryKeyFontAwesomeIcon
      style={{ color: color ? `var(--${color}-color)` : 'var(--dark-02-color)' }}
    />
  </TooltipProvider>
));
