/** @type {import('tailwindcss').Config} */
export default {
  content: ['./renderer/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'wa-green': '#25D366',
        'wa-dark': '#128C7E',
      },
    },
  },
  plugins: [],
};
