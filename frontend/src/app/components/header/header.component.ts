import { Component, ChangeDetectionStrategy } from '@angular/core';


@Component({
  selector: 'app-header',
  standalone: true,
  imports: [],
  template: `
    <header class="header">
      <div class="header-content">
        <div class="logo-section">
          <img src="assets/img/Redis_Logo_Red_RGB.png" alt="Redis Logo" class="logo">
          <h1 class="title">Redis Messaging Patterns</h1>
        </div>
      </div>
    </header>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .header {
      height: 50px;
      background-color: #091A23;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      position: relative;
      z-index: 1000;
    }

    .header-content {
      height: 100%;
      padding: 0 24px;
      display: flex;
      align-items: center;
    }

    .logo-section {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo {
      height: 32px;
      width: auto;
    }

    .title {
      color: white;
      font-size: 24px;
      font-weight: 600;
      margin: 0 0 0 114px;
      letter-spacing: -0.025em;
    }

    @media (max-width: 768px) {
      .title {
        font-size: 16px;
      }
      
      .logo {
        height: 28px;
      }
    }
  `]
})
export class HeaderComponent {}
