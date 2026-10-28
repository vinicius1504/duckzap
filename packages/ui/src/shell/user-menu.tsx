"use client";

import { DropdownMenu as Menu } from "radix-ui";
import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
import { Icon, type IconName } from "../components/icon";
import { useTheme, type ThemePreference } from "../theme";

export type ShellUser = { name: string; initials: string; email?: string };

const themes: { value: ThemePreference; label: string; icon: IconName }[] = [
  { value: "light", label: "Claro", icon: "sun" },
  { value: "dark", label: "Escuro", icon: "moon" },
  { value: "system", label: "Automático", icon: "sliders" },
];

export function UserMenu({
  user,
  onSignOut,
  children,
}: {
  user: ShellUser;
  onSignOut: () => void;
  /** Itens extras (ex.: link para "Minha conta"). */
  children?: ReactNode;
}) {
  const { theme, setTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Menu do usuário: ${user.name}`}
        className="flex h-11 items-center gap-2.5 rounded-control px-1 hover:bg-surface-hover"
      >
        <span className="flex size-9 items-center justify-center rounded-full bg-rail font-extrabold text-duck">
          {user.initials}
        </span>
        <span className="font-semibold max-md:hidden">{user.name}</span>
        <Icon name="chevronDown" size={16} className="text-ink-2 max-md:hidden" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        <DropdownMenuLabel className="text-sm text-ink">
          {user.name}
          {user.email ? <span className="block font-medium text-ink-2">{user.email}</span> : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Tema</DropdownMenuLabel>
        <Menu.RadioGroup value={theme} onValueChange={(value) => setTheme(value as ThemePreference)}>
          {themes.map((option) => (
            <Menu.RadioItem
              key={option.value}
              value={option.value}
              onSelect={(event) => event.preventDefault()}
              className="flex min-h-10 cursor-pointer select-none items-center gap-2.5 rounded-lg px-3 font-medium outline-none data-[highlighted]:bg-surface-hover"
            >
              <Icon name={option.icon} size={18} />
              <span className="flex-1">{option.label}</span>
              <Menu.ItemIndicator>
                <Icon name="check" size={16} strokeWidth={2.2} />
              </Menu.ItemIndicator>
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
        <DropdownMenuSeparator />
        {children}
        <DropdownMenuItem tone="danger" onSelect={onSignOut}>
          <Icon name="logout" size={18} />
          Sair
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
