// Fixtures are imported as text through Vite, so the tests need no file system inside workerd.
declare module '*?raw' {
  const text: string;
  export default text;
}
