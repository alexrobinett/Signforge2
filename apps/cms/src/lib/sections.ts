import {
  CalendarClockIcon,
  ImagesIcon,
  LayersIcon,
  LayoutDashboardIcon,
  ListVideoIcon,
  MonitorIcon,
  PlugIcon,
  ScrollTextIcon,
  SendIcon,
  SettingsIcon,
  type LucideIcon,
} from 'lucide-react';

export interface Section {
  to: '/' | '/screens' | '/spots' | '/playlists' | '/schedule' | '/publishes' | '/assets' | '/integrations' | '/audit' | '/settings';
  label: string;
  icon: LucideIcon;
  description: string;
  empty: { title: string; body: string };
}

/** The dashboard's navigation, in order. */
export const SECTIONS: Section[] = [
  {
    to: '/',
    label: 'Overview',
    icon: LayoutDashboardIcon,
    description: 'Your organization at a glance.',
    empty: { title: '', body: '' },
  },
  {
    to: '/screens',
    label: 'Screens',
    icon: MonitorIcon,
    description: 'The displays that play your content, and whether each is online and up to date.',
    empty: { title: 'No screens yet', body: 'Paired screens will appear here with their status, the content they are playing and when they last checked in.' },
  },
  {
    to: '/spots',
    label: 'Spots',
    icon: LayersIcon,
    description: 'The pieces of content a screen shows: templates filled with your text, images, video or a web page.',
    empty: {
      title: 'Make your first spot from a template',
      body: 'A spot is what a screen shows: a template with your words and pictures, an image, or a web page. Pick a template to start.',
    },
  },
  {
    to: '/playlists',
    label: 'Playlists',
    icon: ListVideoIcon,
    description: 'Ordered spots that play in a loop.',
    empty: {
      title: 'Put your spots in a playlist',
      body: 'A playlist plays spots in order, in a loop, and sets how one gives way to the next. Make one, then add spots to it.',
    },
  },
  {
    to: '/schedule',
    label: 'Schedule',
    icon: CalendarClockIcon,
    description: 'Which playlist plays on which screens, and when.',
    empty: { title: 'Nothing scheduled', body: 'Schedule entries choose a playlist by screen, day and time of day.' },
  },
  {
    to: '/publishes',
    label: 'Publishes',
    icon: SendIcon,
    description: 'What went to screens, when and by whom, how each rollout stands, and rolling screens back.',
    empty: { title: 'Nothing published yet', body: 'Publish a spot or a playlist from its editor, and its rollout to each screen shows here.' },
  },
  {
    to: '/assets',
    label: 'Assets',
    icon: ImagesIcon,
    description: 'Images and video uploaded for your spots.',
    empty: { title: 'No assets yet', body: 'Uploaded images and video, checked for the screens they will play on, will be kept here.' },
  },
  {
    to: '/integrations',
    label: 'Integrations',
    icon: PlugIcon,
    description:
      'Data reaches screens through our server, never directly: each source is fetched and checked there, and screens get the new copy with their next sync. When a source is down, they keep the last good copy for a day.',
    empty: { title: 'No data sources yet', body: 'Feeds, calendars and weather your spots read will be listed here with their health.' },
  },
  {
    to: '/audit',
    label: 'Audit log',
    icon: ScrollTextIcon,
    description: 'Every change by a person, agent or screen.',
    empty: { title: '', body: '' },
  },
  {
    to: '/settings',
    label: 'Settings',
    icon: SettingsIcon,
    description: "Your organization's defaults, members and alerts.",
    empty: { title: '', body: '' },
  },
];

/** An empty list's word to a viewer, who cannot make the first one. */
export const ASK_AN_EDITOR = 'Ask an editor or owner to make one.';

export const sectionFor = (to: Section['to']) => SECTIONS.find((s) => s.to === to)!;
